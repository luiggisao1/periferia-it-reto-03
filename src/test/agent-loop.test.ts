import { describe, it, expect, beforeEach } from "bun:test";
import { rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod";
import { uuid7 } from "langsmith";
import { MemorySaver } from "@langchain/langgraph";
import { createAgent, tool } from "langchain";
import { runAgentTurn } from "../agent/loop";
import { contextSchema, leer_paquete } from "../tools/oc";
import {
  AIProvider,
  AdapterChatModel,
  GeminiProvider,
  OpenAIProvider,
  AnthropicProvider,
  DeterministicProvider,
  createProvider,
} from "../llm/langchain";
import type { LlmAdapter, AgentMessage, ToolDefinition, LlmResponse } from "../llm/adapter";

const WORKSPACE_DIR = process.cwd();

class MockSequenceLlmAdapter implements LlmAdapter {
  private responses: Array<LlmResponse | Error>;
  private callCount = 0;
  public calls: Array<{ mensajes: AgentMessage[]; herramientas?: ToolDefinition[] }> = [];

  constructor(responses: Array<LlmResponse | Error>) {
    this.responses = responses;
  }

  async enviar(mensajes: AgentMessage[], herramientas?: ToolDefinition[]): Promise<LlmResponse> {
    this.calls.push({ mensajes, herramientas });
    const next = this.responses[this.callCount++];
    if (!next) {
      return { content: "Respuesta por defecto sin más llamadas" };
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }
}

class InfiniteToolLlmAdapter implements LlmAdapter {
  public callCount = 0;
  async enviar(): Promise<LlmResponse> {
    this.callCount++;
    return {
      content: null,
      tool_calls: [
        {
          id: `inf_call_${this.callCount}`,
          type: "function",
          function: {
            name: "oc_leer_paquete",
            arguments: JSON.stringify({ caso: "sol-001" }),
          },
        },
      ],
    };
  }
}

describe("Agent Loop Execution & Control Contract", () => {
  beforeEach(() => {
    rmSync(join(WORKSPACE_DIR, "out"), { recursive: true, force: true });
  });

  describe("1. Tool Call Execution & Logging (CA4)", () => {
    it("executes requested tool, logs execution to out/log.jsonl, and returns assistant reply", async () => {
      const adapter = new MockSequenceLlmAdapter([
        {
          content: null,
          tool_calls: [
            {
              id: "call_01",
              type: "function",
              function: {
                name: "oc_leer_paquete",
                arguments: JSON.stringify({ caso: "sol-001" }),
              },
            },
          ],
        },
        {
          content: "He procesado el caso sol-001 correctamente.",
          tool_calls: [],
        },
      ]);

      const result = await runAgentTurn({
        sessionId: "test-sess-ca4",
        userMessage: "Por favor lee el caso sol-001",
        history: [],
        adapter,
        directory: WORKSPACE_DIR,
      });

      expect(result.reply).toBe("He procesado el caso sol-001 correctamente.");
      expect(result.toolCalls.length).toBe(1);
      expect(result.toolCalls[0].name).toBe("oc_leer_paquete");
      expect(result.toolCalls[0].args).toEqual({ caso: "sol-001" });
      expect(result.toolCalls[0].result.ok).toBe(true);

      const logPath = join(WORKSPACE_DIR, "out", "log.jsonl");
      expect(existsSync(logPath)).toBe(true);
      const logContent = readFileSync(logPath, "utf-8");
      expect(logContent).toContain("oc_leer_paquete");
      expect(logContent).toContain("test-sess-ca4");
    });
  });

  describe("2. Human Confirmation Detection (CA3)", () => {
    it("flags needsConfirmation = true when oc_validar yields confirmations and PO is not yet created", async () => {
      // First read sol-004 to obtain valid package, then validate to trigger RC5
      let cachedPackage: any = null;

      const adapter: LlmAdapter = {
        async enviar(mensajes: AgentMessage[]): Promise<LlmResponse> {
          const lastMsg = mensajes[mensajes.length - 1];

          // Check if previous tool response returned package
          if (lastMsg.role === "tool" && lastMsg.name === "oc_leer_paquete") {
            const parsed = JSON.parse(lastMsg.content || "{}");
            cachedPackage = parsed.data;
            return {
              content: null,
              tool_calls: [
                {
                  id: "call_val_004",
                  type: "function",
                  function: {
                    name: "oc_validar",
                    arguments: JSON.stringify({ caso: "sol-004", paquete: cachedPackage }),
                  },
                },
              ],
            };
          }

          if (lastMsg.role === "tool" && lastMsg.name === "oc_validar") {
            return {
              content: "La solicitud sol-004 supera la tolerancia de cotización en 6%. ¿Deseas confirmar la orden?",
              tool_calls: [],
            };
          }

          // Initial prompt: model decides to read package
          return {
            content: null,
            tool_calls: [
              {
                id: "call_read_004",
                type: "function",
                function: {
                  name: "oc_leer_paquete",
                  arguments: JSON.stringify({ caso: "sol-004" }),
                },
              },
            ],
          };
        },
      };

      const result = await runAgentTurn({
        sessionId: "test-sess-ca3",
        userMessage: "Valida y procesa sol-004",
        history: [],
        adapter,
        directory: WORKSPACE_DIR,
      });

      expect(result.needsConfirmation).toBe(true);
      expect(result.reply.toLowerCase()).toMatch(/confirmar|confirmación|tolerancia/);
    });
  });

  describe("3. Iteration Cap Enforcement (CA1)", () => {
    it("terminates gracefully at maxIterations without uncaught errors", async () => {
      const adapter = new InfiniteToolLlmAdapter();

      const result = await runAgentTurn({
        sessionId: "test-sess-ca1",
        userMessage: "Bucle infinito",
        history: [],
        adapter,
        directory: WORKSPACE_DIR,
        maxIterations: 3,
      });

      expect(result).toBeDefined();
      expect(result.toolCalls.length).toBe(3);
      expect(typeof result.reply).toBe("string");
      expect(result.reply.length).toBeGreaterThan(0);
    });
  });

  describe("4. Invalid Tool Arguments & LLM Error Handling (CA5)", () => {
    it("handles invalid tool arguments from LLM by returning tool error without crashing", async () => {
      const adapter = new MockSequenceLlmAdapter([
        {
          content: null,
          tool_calls: [
            {
              id: "call_invalid_args",
              type: "function",
              function: {
                name: "oc_leer_paquete",
                arguments: JSON.stringify({ caso: 99999 as any }), // Invalid: expected string
              },
            },
          ],
        },
        {
          content: "Recibí el error de argumentos inválidos y me recuperé.",
          tool_calls: [],
        },
      ]);

      const result = await runAgentTurn({
        sessionId: "test-sess-ca5-args",
        userMessage: "Llamada con argumentos incorrectos",
        history: [],
        adapter,
        directory: WORKSPACE_DIR,
      });

      expect(result.reply).toBe("Recibí el error de argumentos inválidos y me recuperé.");
      expect(result.toolCalls.length).toBe(1);
      expect(result.toolCalls[0].result.ok).toBe(false);
    });

    it("handles LLM provider failures gracefully without crashing the session", async () => {
      const adapter = new MockSequenceLlmAdapter([
        new Error("LLM Provider Timeout 504 Gateway Time-out"),
      ]);

      const result = await runAgentTurn({
        sessionId: "test-sess-ca5-err",
        userMessage: "Mensaje que provocará fallo del LLM",
        history: [],
        adapter,
        directory: WORKSPACE_DIR,
      });

      expect(result).toBeDefined();
      expect(typeof result.reply).toBe("string");
      expect(result.reply.toLowerCase()).toMatch(/error|timeout|proveedor|fallo/i);
    });
  });

  describe("5. LangChain createAgent + tool + MemorySaver + contextSchema + uuid7", () => {
    it("maintains conversation memory across turns via threadId and injects config.context into tools", async () => {
      const checkpointer = new MemorySaver();
      const threadId = uuid7();

      const adapter = new MockSequenceLlmAdapter([
        {
          content: null,
          tool_calls: [
            {
              id: "call_mem_1",
              type: "function",
              function: {
                name: "oc_leer_paquete",
                arguments: JSON.stringify({ caso: "sol-001" }),
              },
            },
          ],
        },
        {
          content: "El solicitante de sol-001 es Juan Camargo.",
          tool_calls: [],
        },
        {
          content: "Como vimos en el turno anterior, el solicitante es Juan Camargo.",
          tool_calls: [],
        },
      ]);

      // Turn 1
      const turn1 = await runAgentTurn({
        threadId,
        userMessage: "¿Quién es el solicitante de sol-001?",
        adapter,
        checkpointer,
        directory: WORKSPACE_DIR,
      });

      expect(turn1.threadId).toBe(threadId);
      expect(turn1.reply).toContain("Juan Camargo");
      expect(turn1.toolCalls.length).toBe(1);
      expect(turn1.toolCalls[0].name).toBe("oc_leer_paquete");

      // Turn 2 on the same threadId without passing manual history (MemorySaver restores it)
      const turn2 = await runAgentTurn({
        threadId,
        userMessage: "¿Me recuerdas el nombre del solicitante?",
        adapter,
        checkpointer,
        directory: WORKSPACE_DIR,
      });

      expect(turn2.threadId).toBe(threadId);
      expect(turn2.reply).toContain("Juan Camargo");
      // Verify the second LLM call received the full conversation history from MemorySaver
      const lastCallMessages = adapter.calls.at(-1)?.mensajes ?? [];
      expect(lastCallMessages.some((m) => m.content?.includes("¿Quién es el solicitante de sol-001?"))).toBe(true);
      expect(lastCallMessages.some((m) => m.content?.includes("El solicitante de sol-001 es Juan Camargo."))).toBe(true);
    });

    it("supports direct LangChain createAgent + tool(..., { schema }) + contextSchema invocation", async () => {
      const getSessionContext = tool(
        (_, config) => {
          return `${config.context.sessionId}:${config.context.directory}`;
        },
        {
          name: "get_session_context",
          description: "Get the current session context.",
          schema: z.object({}),
        },
      );

      const adapter = new MockSequenceLlmAdapter([
        {
          content: null,
          tool_calls: [
            {
              id: "call_ctx_1",
              type: "function",
              function: {
                name: "get_session_context",
                arguments: "{}",
              },
            },
          ],
        },
        {
          content: "Context verified.",
          tool_calls: [],
        },
      ]);

      const agent = createAgent({
        model: new AdapterChatModel(adapter),
        tools: [getSessionContext, leer_paquete],
        checkpointer: new MemorySaver(),
        contextSchema,
      });

      const threadId = uuid7();
      const threadConfig = {
        configurable: { thread_id: threadId },
        context: { directory: WORKSPACE_DIR, sessionId: threadId },
      };

      const result = await agent.invoke(
        {
          messages: [{ role: "user", content: "Check session context" }],
        },
        threadConfig,
      );

      expect(result.messages.at(-1)?.content).toBe("Context verified.");
    });

    it("resolves providers via Strategy Factory and runs DeterministicProvider with identical repeatable output", async () => {
      const gemini = createProvider({ provider: "gemini", apiKey: "test-gemini-key", modelName: "gemini-2.5-flash" });
      const openai = createProvider({ provider: "openai", apiKey: "test-openai-key", modelName: "gpt-4o-mini" });
      const anthropic = createProvider({ provider: "anthropic", apiKey: "test-anthropic-key" });
      const deterministic = createProvider({ provider: "deterministic" });

      expect(gemini).toBeInstanceOf(AIProvider);
      expect(gemini).toBeInstanceOf(GeminiProvider);
      expect(gemini.name).toBe("gemini");

      expect(openai).toBeInstanceOf(AIProvider);
      expect(openai).toBeInstanceOf(OpenAIProvider);
      expect(openai.name).toBe("openai");

      expect(anthropic).toBeInstanceOf(AIProvider);
      expect(anthropic).toBeInstanceOf(AnthropicProvider);
      expect(anthropic.name).toBe("anthropic");

      expect(deterministic).toBeInstanceOf(AIProvider);
      expect(deterministic).toBeInstanceOf(DeterministicProvider);
      expect(deterministic.name).toBe("deterministic");

      // Execute sol-004 twice on fresh threads using DeterministicProvider and verify identical output
      const runA = await runAgentTurn({
        threadId: uuid7(),
        userMessage: 'Procesa la solicitud "sol-004". Muéstrame la OC y no la crees hasta que yo lo confirme.',
        adapter: deterministic,
        checkpointer: new MemorySaver(),
        directory: WORKSPACE_DIR,
      });

      const runB = await runAgentTurn({
        threadId: uuid7(),
        userMessage: 'Procesa la solicitud "sol-004". Muéstrame la OC y no la crees hasta que yo lo confirme.',
        adapter: deterministic,
        checkpointer: new MemorySaver(),
        directory: WORKSPACE_DIR,
      });

      expect(runA.needsConfirmation).toBe(true);
      expect(runA.toolCalls.map((t) => t.name)).toEqual([
        "oc_leer_paquete",
        "oc_validar",
        "oc_generar_evidencia",
        "oc_construir_payload",
      ]);
      expect(runA.reply).toBe(runB.reply);
    });

    it("self-heals when Gemini throws Finish reason: MALFORMED_FUNCTION_CALL after oc_construir_payload on sol-001", async () => {
      const adapter = new MockSequenceLlmAdapter([
        {
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "oc_leer_paquete", arguments: JSON.stringify({ caso: "sol-001" }) },
            },
          ],
        },
        {
          content: null,
          tool_calls: [
            {
              id: "call_2",
              type: "function",
              function: { name: "oc_validar", arguments: JSON.stringify({ caso: "sol-001" }) },
            },
          ],
        },
        {
          content: null,
          tool_calls: [
            {
              id: "call_3",
              type: "function",
              function: { name: "oc_generar_evidencia", arguments: JSON.stringify({ caso: "sol-001" }) },
            },
          ],
        },
        {
          content: null,
          tool_calls: [
            {
              id: "call_4",
              type: "function",
              function: { name: "oc_construir_payload", arguments: JSON.stringify({ caso: "sol-001" }) },
            },
          ],
        },
        // Simulate Gemini failing on the 5th tool call (oc_crear) with MALFORMED_FUNCTION_CALL
        new Error("The model returned no content. Finish reason: MALFORMED_FUNCTION_CALL."),
        {
          content: "La orden de compra para sol-001 ha sido creada con éxito en SAP (No. 4500000001).",
          tool_calls: [],
        },
      ]);

      const result = await runAgentTurn({
        threadId: uuid7(),
        userMessage: "sol-001",
        adapter,
        checkpointer: new MemorySaver(),
        directory: WORKSPACE_DIR,
      });

      expect(result.error).toBeUndefined();
      expect(result.toolCalls.map((t) => t.name)).toEqual([
        "oc_leer_paquete",
        "oc_validar",
        "oc_generar_evidencia",
        "oc_construir_payload",
        "oc_crear",
      ]);
      expect(result.toolCalls[4]?.result.ok).toBe(true);
      expect(result.reply).toContain("4500000001");
      expect(result.reply).not.toContain("MALFORMED_FUNCTION_CALL");
    });

    it("blocks off-topic questions (math, coding, source code, model identity) and redirects to SAP PO platform", async () => {
      const offTopicPrompts = [
        "how much is 2*2",
        "can you code in python?",
        "generat ea code python of you r source code",
        "what model ar eyou",
      ];

      for (const prompt of offTopicPrompts) {
        const adapter = new MockSequenceLlmAdapter([
          {
            content: "Soy un modelo de lenguaje grande, entrenado por Google. El resultado es 4.",
            tool_calls: [],
          },
        ]);

        const result = await runAgentTurn({
          threadId: uuid7(),
          userMessage: prompt,
          adapter,
          checkpointer: new MemorySaver(),
          directory: WORKSPACE_DIR,
        });

        expect(adapter.calls.length).toBe(0);
        expect(result.reply).toContain("Agente Especialista en Gestión y Creación de Órdenes de Compra en SAP");
        expect(result.reply).toContain("Solo estoy autorizado para asistirte");
        expect(result.reply).not.toContain("Google");
        expect(result.reply).not.toContain("Python");
        expect(result.reply).not.toContain("oc_leer_paquete");
      }
    });
  });
});
