import { describe, it, expect, beforeEach } from "bun:test";
import { rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runAgentTurn } from "../agent/loop";
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
});
