import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type {
  LlmAdapter,
  AgentMessage,
  ToolDefinition,
  LlmResponse,
  ToolCallRequest,
} from "./adapter";

export interface LangChainModelConfig {
  provider?: "openai" | "google" | "anthropic";
  modelName?: string;
  apiKey?: string;
  temperature?: number;
}

export class LangChainLlmAdapter implements LlmAdapter {
  private config: LangChainModelConfig;

  constructor(config?: LangChainModelConfig) {
    this.config = config ?? {};
  }

  async enviar(mensajes: AgentMessage[], herramientas?: ToolDefinition[]): Promise<LlmResponse> {
    const provider = this.config.provider ?? (process.env.LLM_PROVIDER as "openai" | "google" | "anthropic") ?? "openai";

    // 1. Convertir mensajes de AgentMessage[] a BaseMessage[] de LangChain
    const lcMessages: BaseMessage[] = mensajes.map((m) => {
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
              })),
            });
          }
          return new AIMessage(m.content ?? "");
        }
        case "tool":
          return new ToolMessage({
            content: m.content ?? "",
            tool_call_id: m.tool_call_id ?? `call_${Date.now()}`,
            name: m.name,
          });
        default:
          return new HumanMessage(m.content ?? "");
      }
    });

    // 2. Instanciar cliente según proveedor
    let model: any;
    if (provider === "google") {
      const { ChatGoogleGenerativeAI } = await import("@langchain/google-genai");
      model = new ChatGoogleGenerativeAI({
        model: this.config.modelName ?? process.env.GOOGLE_MODEL ?? "gemini-1.5-flash",
        apiKey: this.config.apiKey ?? process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY,
        temperature: this.config.temperature ?? 0.1,
      });
    } else if (provider === "anthropic") {
      const { ChatAnthropic } = await import("@langchain/anthropic");
      model = new ChatAnthropic({
        modelName: this.config.modelName ?? process.env.ANTHROPIC_MODEL ?? "claude-3-5-sonnet-20241022",
        apiKey: this.config.apiKey ?? process.env.ANTHROPIC_API_KEY,
        temperature: this.config.temperature ?? 0.1,
      });
    } else {
      const { ChatOpenAI } = await import("@langchain/openai");
      model = new ChatOpenAI({
        modelName: this.config.modelName ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini",
        apiKey: this.config.apiKey ?? process.env.OPENAI_API_KEY,
        temperature: this.config.temperature ?? 0.1,
      });
    }

    // 3. Vincular herramientas si se proporcionaron
    if (herramientas && herramientas.length > 0) {
      const formattedTools = herramientas.map((h) => ({
        type: "function" as const,
        function: {
          name: h.function.name,
          description: h.function.description,
          parameters: h.function.parameters,
        },
      }));
      model = model.bindTools(formattedTools);
    }

    // 4. Invocar modelo
    const response = (await model.invoke(lcMessages)) as AIMessage;

    // 5. Mapear respuesta
    const toolCalls: ToolCallRequest[] = [];
    if (response.tool_calls && response.tool_calls.length > 0) {
      for (const tc of response.tool_calls) {
        toolCalls.push({
          id: tc.id ?? `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          type: "function",
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.args ?? {}),
          },
        });
      }
    }

    const contentText = typeof response.content === "string" ? response.content : JSON.stringify(response.content);

    return {
      content: contentText || null,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: (response as any).usage_metadata
        ? {
            prompt_tokens: (response as any).usage_metadata.input_tokens,
            completion_tokens: (response as any).usage_metadata.output_tokens,
            total_tokens: (response as any).usage_metadata.total_tokens,
          }
        : undefined,
    };
  }
}

/**
 * Adaptador heurístico determinista para pruebas locales o demostraciones sin API key externa
 */
export class HeuristicFallbackLlmAdapter implements LlmAdapter {
  async enviar(mensajes: AgentMessage[], _herramientas?: ToolDefinition[]): Promise<LlmResponse> {
    const lastUser = [...mensajes].reverse().find((m) => m.role === "user");
    const lastTool = [...mensajes].reverse().find((m) => m.role === "tool");
    const userText = lastUser?.content?.toLowerCase() ?? "";

    // Detectar caso mencionado (sol-001 a sol-006)
    const casoMatch = userText.match(/\b(sol-\d{3})\b/i);
    const caso = casoMatch ? casoMatch[1]?.toLowerCase() : "sol-001";

    // Si aún no hemos llamado a oc_leer_paquete para este caso
    const hasRead = mensajes.some(
      (m) => m.role === "tool" && m.name === "oc_leer_paquete"
    );
    if (!hasRead) {
      return {
        content: null,
        tool_calls: [
          {
            id: `call_read_${Date.now()}`,
            type: "function",
            function: {
              name: "oc_leer_paquete",
              arguments: JSON.stringify({ caso }),
            },
          },
        ],
      };
    }

    // Si leímos paquete pero no hemos validado
    const hasValidated = mensajes.some(
      (m) => m.role === "tool" && m.name === "oc_validar"
    );
    if (!hasValidated) {
      const readMsg = mensajes.find(
        (m) => m.role === "tool" && m.name === "oc_leer_paquete"
      );
      let pkg: unknown = {};
      try {
        pkg = JSON.parse(readMsg?.content || "{}").data;
      } catch {}

      return {
        content: null,
        tool_calls: [
          {
            id: `call_val_${Date.now()}`,
            type: "function",
            function: {
              name: "oc_validar",
              arguments: JSON.stringify({ caso, paquete: pkg }),
            },
          },
        ],
      };
    }

    // Revisar resultado de validación
    const valMsg = mensajes.find(
      (m) => m.role === "tool" && m.name === "oc_validar"
    );
    let valResult: any = null;
    try {
      valResult = JSON.parse(valMsg?.content || "{}").data;
    } catch {}

    if (valResult && !valResult.apta) {
      const bloqueosDesc = valResult.bloqueos
        ?.map((b: any) => `• [${b.codigo}] ${b.detalle} (Acción: ${b.accion_sugerida})`)
        .join("\n");
      return {
        content: `La solicitud ${caso.toUpperCase()} fue **BLOQUEADA** por control interno de compras:\n\n${bloqueosDesc}\n\nNo es posible generar la orden de compra en SAP hasta que se subsanen estos requisitos.`,
        tool_calls: [],
      };
    }

    // Si requiere confirmación y el usuario no ha dicho confirmar
    const hasConfirmationRules =
      valResult?.confirmaciones && valResult.confirmaciones.length > 0;
    const isUserConfirming =
      userText.includes("confirmo") ||
      userText.includes("confirmar") ||
      userText.includes("proceder") ||
      userText.includes("sí") ||
      userText.includes("si");

    if (hasConfirmationRules && !isUserConfirming) {
      const confDesc = valResult.confirmaciones
        ?.map((c: any) => `• [${c.codigo}] ${c.detalle} (Acción: ${c.accion_sugerida})`)
        .join("\n");
      return {
        content: `La solicitud ${caso.toUpperCase()} es apta pero presenta observaciones que requieren **confirmación explícita**:\n\n${confDesc}\n\n¿Deseas confirmar la creación de la orden de compra con estas condiciones?`,
        tool_calls: [],
      };
    }

    // Si ya confirmó o no requería confirmación, y no hemos creado
    const hasCreated = mensajes.some(
      (m) => m.role === "tool" && m.name === "oc_crear"
    );
    if (!hasCreated) {
      return {
        content: null,
        tool_calls: [
          {
            id: `call_create_${Date.now()}`,
            type: "function",
            function: {
              name: "oc_crear",
              arguments: JSON.stringify({ caso, confirmado: isUserConfirming }),
            },
          },
        ],
      };
    }

    // Si ya creamos, retornar resumen
    const createMsg = mensajes.find(
      (m) => m.role === "tool" && m.name === "oc_crear"
    );
    let createRes: any = {};
    try {
      createRes = JSON.parse(createMsg?.content || "{}");
    } catch {}

    if (createRes.ok) {
      return {
        content: `¡Orden de Compra procesada exitosamente en SAP!\n\n• **Número OC**: ${createRes.data.numero_oc}\n• **Fecha**: ${createRes.data.fecha}\n• **Estado**: ${createRes.data.idempotente ? "Reutilizada (Idempotente)" : "Creada nueva"}\n• **Evidencia**: out/${caso}/aprobacion.pdf`,
        tool_calls: [],
      };
    } else {
      return {
        content: `No se pudo crear la orden de compra: ${createRes.error}`,
        tool_calls: [],
      };
    }
  }
}

export function createLlmAdapter(): LlmAdapter {
  if (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY) {
    return new LangChainLlmAdapter({ provider: "google" });
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return new LangChainLlmAdapter({ provider: "anthropic" });
  }
  if (process.env.OPENAI_API_KEY) {
    return new LangChainLlmAdapter({ provider: "openai" });
  }
  return new HeuristicFallbackLlmAdapter();
}
