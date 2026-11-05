import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import {
  BaseChatModel,
  type BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import type {
  LlmAdapter,
  AgentMessage,
  ToolDefinition,
  LlmResponse,
  ToolCallRequest,
} from "./adapter";

/**
 * Convierte BaseMessage[] de LangChain a AgentMessage[] del contrato LlmAdapter.
 */
export function baseMessagesToAgentMessages(messages: BaseMessage[]): AgentMessage[] {
  return messages.map((m) => {
    const type = m._getType();
    const textContent =
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content
              .map((block) =>
                typeof block === "string"
                  ? block
                  : typeof block === "object" && block !== null && "text" in block
                    ? String((block as { text?: unknown }).text ?? "")
                    : ""
              )
              .join("")
          : String(m.content ?? "");

    if (type === "system") {
      return { role: "system", content: textContent };
    }
    if (type === "human") {
      return { role: "user", content: textContent };
    }
    if (type === "tool" || ToolMessage.isInstance(m)) {
      const tm = m as ToolMessage;
      return {
        role: "tool",
        name: tm.name,
        tool_call_id: tm.tool_call_id,
        content: textContent,
      };
    }
    if (type === "ai" || AIMessage.isInstance(m)) {
      const ai = m as AIMessage;
      const toolCalls: ToolCallRequest[] | undefined =
        ai.tool_calls && ai.tool_calls.length > 0
          ? ai.tool_calls.map((tc, i) => ({
              id: tc.id ?? `call_${Date.now()}_${i}`,
              type: "function" as const,
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.args ?? {}),
              },
            }))
          : undefined;
      return {
        role: "assistant",
        content: textContent || null,
        tool_calls: toolCalls,
      };
    }
    return { role: "user", content: textContent };
  });
}

/**
 * Convierte AgentMessage[] del contrato LlmAdapter a BaseMessage[] de LangChain.
 */
export function agentMessagesToBaseMessages(mensajes: AgentMessage[]): BaseMessage[] {
  return mensajes.map((m) => {
    switch (m.role) {
      case "system":
        return new SystemMessage(m.content ?? "");
      case "user":
        return new HumanMessage(m.content ?? "");
      case "assistant": {
        if (m.tool_calls && m.tool_calls.length > 0) {
          return new AIMessage({
            content: m.content ?? "",
            tool_calls: m.tool_calls.map((tc) => ({
              id: tc.id,
              name: tc.function.name,
              args: (() => {
                try {
                  return JSON.parse(tc.function.arguments);
                } catch {
                  return {};
                }
              })(),
              type: "tool_call",
            })),
          });
        }
        return new AIMessage(m.content ?? "");
      }
      case "tool":
        return new ToolMessage({
          content: m.content ?? "",
          tool_call_id: m.tool_call_id ?? "unknown_call",
          name: m.name,
        });
    }
  });
}

/**
 * Envuelve cualquier `LlmAdapter` / `AIProvider` como un `BaseChatModel` compatible con `createAgent` de `langchain`.
 */
export class AdapterChatModel extends BaseChatModel {
  private adapter: LlmAdapter;
  private boundToolDefs?: ToolDefinition[];

  constructor(adapter: LlmAdapter, boundToolDefs?: ToolDefinition[], fields?: BaseChatModelParams) {
    super(fields ?? {});
    this.adapter = adapter;
    this.boundToolDefs = boundToolDefs;
  }

  _llmType(): string {
    return "sap_oc_adapter_chat_model";
  }

  override bindTools(tools: unknown[]): AdapterChatModel {
    const defs: ToolDefinition[] = tools.map((t) => {
      const toolObj = t as {
        name?: string;
        description?: string;
        schema?: Record<string, unknown>;
        function?: {
          name: string;
          description: string;
          parameters: {
            type: "object";
            properties: Record<string, unknown>;
            required?: string[];
          };
        };
      };
      if (toolObj.function) {
        return {
          type: "function",
          function: toolObj.function,
        };
      }
      return {
        type: "function",
        function: {
          name: toolObj.name ?? "unknown_tool",
          description: toolObj.description ?? "",
          parameters: {
            type: "object",
            properties: (toolObj.schema as Record<string, unknown>) ?? {},
          },
        },
      };
    });
    return new AdapterChatModel(this.adapter, defs);
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const agentMessages = baseMessagesToAgentMessages(messages);
    const response = await this.adapter.enviar(agentMessages, this.boundToolDefs);

    const lcToolCalls =
      response.tool_calls?.map((tc) => {
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs =
            typeof tc.function.arguments === "string"
              ? JSON.parse(tc.function.arguments)
              : (tc.function.arguments as Record<string, unknown>);
        } catch {
          parsedArgs = {};
        }
        return {
          id: tc.id,
          name: tc.function.name,
          args: parsedArgs,
          type: "tool_call" as const,
        };
      }) ?? [];

    const aiMessage = new AIMessage({
      content: response.content ?? "",
      tool_calls: lcToolCalls,
      usage_metadata: response.usage
        ? {
            input_tokens: response.usage.prompt_tokens ?? 0,
            output_tokens: response.usage.completion_tokens ?? 0,
            total_tokens: response.usage.total_tokens ?? 0,
          }
        : undefined,
    });

    return {
      generations: [
        {
          text: response.content ?? "",
          message: aiMessage,
        },
      ],
    };
  }
}

/**
 * Clase base abstracta del patrón Strategy para proveedores de IA (inspirado en interviewer-ai `AIProvider` / `BaseLLMProvider`).
 */
export abstract class AIProvider implements LlmAdapter {
  abstract readonly name: string;
  abstract readonly model: string;

  get provider(): string {
    return this.name;
  }

  /**
   * Retorna el `BaseChatModel` de LangChain que se inyecta en `createAgent({ model, tools, checkpointer, contextSchema })`.
   */
  getChatModel(): BaseChatModel {
    return new AdapterChatModel(this);
  }

  /**
   * Método auxiliar compartido por proveedores basados en modelos de chat de LangChain.
   */
  protected async invokeLangChainModel(
    chatModel: BaseChatModel,
    mensajes: AgentMessage[],
    herramientas?: ToolDefinition[],
  ): Promise<LlmResponse> {
    const lcMessages = agentMessagesToBaseMessages(mensajes);

    const runnable =
      herramientas && herramientas.length > 0 && typeof chatModel.bindTools === "function"
        ? chatModel.bindTools(herramientas)
        : chatModel;

    const response = (await runnable.invoke(lcMessages)) as AIMessage;

    const textContent =
      typeof response.content === "string"
        ? response.content
        : Array.isArray(response.content)
          ? response.content
              .map((block) =>
                typeof block === "string"
                  ? block
                  : typeof block === "object" && block !== null && "text" in block
                    ? String((block as { text?: unknown }).text ?? "")
                    : ""
              )
              .join("")
          : null;

    const toolCalls: ToolCallRequest[] | undefined =
      response.tool_calls && response.tool_calls.length > 0
        ? response.tool_calls.map((tc, idx) => ({
            id: tc.id ?? `call_${Date.now()}_${idx}`,
            type: "function",
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.args ?? {}),
            },
          }))
        : undefined;

    const usageMeta = (
      response as unknown as {
        usage_metadata?: {
          input_tokens?: number;
          output_tokens?: number;
          total_tokens?: number;
        };
      }
    ).usage_metadata;

    return {
      content: textContent || null,
      tool_calls: toolCalls,
      usage: usageMeta
        ? {
            prompt_tokens: usageMeta.input_tokens,
            completion_tokens: usageMeta.output_tokens,
            total_tokens: usageMeta.total_tokens,
          }
        : undefined,
    };
  }

  abstract enviar(mensajes: AgentMessage[], herramientas?: ToolDefinition[]): Promise<LlmResponse>;
}

export const BaseLLMProvider = AIProvider;
export type BaseLLMProvider = AIProvider;
