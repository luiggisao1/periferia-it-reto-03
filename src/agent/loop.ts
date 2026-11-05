import * as z from "zod";
import { uuid7 } from "langsmith";
import { MemorySaver } from "@langchain/langgraph";
import { AIMessage, ToolMessage, createAgent, createMiddleware } from "langchain";
import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { LlmAdapter, AgentMessage } from "../llm/adapter";
import {
  AIProvider,
  AdapterChatModel,
  baseMessagesToAgentMessages,
} from "../llm/base";
import { DeterministicProvider } from "../llm/deterministic_provider";
import { ocTools, langchainTools, contextSchema } from "../tools/oc";

export type { AgentMessage };

/**
 * Instancia compartida de MemorySaver (@langchain/langgraph) para persistir
 * el historial conversacional por `thread_id`.
 */
export const memoryCheckpointer = new MemorySaver();
export const defaultMemorySaver = memoryCheckpointer;

export interface RunAgentTurnOptions {
  sessionId?: string;
  threadId?: string;
  userMessage: string;
  history?: AgentMessage[];
  adapter: LlmAdapter;
  directory?: string;
  maxIterations?: number;
  maxSessionTokens?: number;
  currentSessionTokens?: number;
  checkpointer?: MemorySaver;
}

export interface ExecutedToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result: { ok: boolean; data?: unknown; error?: unknown };
  rawResult?: string;
  durationMs: number;
  timestamp: string;
}

export interface RunAgentTurnResult {
  threadId: string;
  reply: string;
  toolCalls: ExecutedToolCall[];
  needsConfirmation: boolean;
  updatedHistory: AgentMessage[];
  tokensUsed: number;
  error?: string;
}

export const OFF_TOPIC_GUARDRAIL_REPLY =
  "Soy el Agente Especialista en Gestión y Creación de Órdenes de Compra en SAP de Periferia IT Group. Solo estoy autorizado para asistirte en la revisión, validación y creación de solicitudes y órdenes de compra dentro de esta plataforma (por ejemplo, `sol-001` a `sol-006`). ¿Qué solicitud de compra deseas procesar?";

const PLATFORM_DOMAIN_KEYWORDS =
  /\b(sol-\d{3}|sap|orden|órdenes|ordenes|compra|compras|solicitud|solicitudes|proveedor|proveedores|cotizaci|presupuesto|aprobaci|aprobador|factura|iva|impuesto|regla|rc\d+|centro de costo|ceco|confirm|proceder|paquete|evidencia|caso|solicitante|nit|sociedad|periferia|perxia|trazabilidad|idempoten|payload|excel|adjunto)\b/i;

const OFF_TOPIC_OR_PROBING_PATTERNS = [
  /\b\d+\s*[*+\-/x÷]\s*\d+\b/i,
  /\b(how much is|cu[aá]nto es|calcula|resuelve)\b/i,
  /\b(python|javascript|typescript|java|c\+\+|c#|golang|rust|ruby|php|html|css|bash|shell|code|coding|programar|programaci[oó]n|source\s*code|c[oó]digo\s*fuente|script)\b/i,
  /\b(what\s+model|which\s+model|qu[eé]\s+modelo|model\s+ar\s*e\s*you|who\s+trained|qui[eé]n\s+te\s+entren[oó]|system\s*prompt|prompt\s+del\s+sistema|openai|chatgpt|gpt-\d|gemini|anthropic|claude|large\s+language\s+model|modelo\s+de\s+lenguaje)\b/i,
  /\b(tell\s+me\s+a\s+joke|cu[eé]ntame\s+un\s+chiste|write\s+a\s+poem|escribe\s+un\s+poema|receta\s+de|weather\s+in|clima\s+en)\b/i,
];

const OUTPUT_LEAKAGE_PATTERNS =
  /modelo de lenguaje grande|large language model|entrenado por google|trained by google|puedo generar c[oó]digo python|```python|oc_leer_paquete|oc_validar|oc_construir_payload|oc_generar_evidencia|oc_crear/i;

export function isOffTopicQuery(userMessage: string): boolean {
  const trimmed = userMessage.trim();
  if (!trimmed) return false;
  if (PLATFORM_DOMAIN_KEYWORDS.test(trimmed)) {
    return false;
  }
  return OFF_TOPIC_OR_PROBING_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function appendLog(
  directory: string,
  entry: {
    sessionId: string;
    ts: string;
    tool: string;
    args: unknown;
    result: unknown;
  },
) {
  const outDir = join(directory, "out");
  mkdirSync(outDir, { recursive: true });
  const logPath = join(outDir, "log.jsonl");
  appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
}

function loadSystemPrompt(directory: string): string {
  let systemContent =
    "Eres el Agente Especialista en Órdenes de Compra SAP para Periferia IT Group. Validas paquetes de compra contra maestros y controles internos.";

  const promptPath = join(directory, "agent", "prompt.md");
  if (existsSync(promptPath)) {
    systemContent = readFileSync(promptPath, "utf-8");
  }

  const knowledgePath = join(directory, "src", "knowledge", "ordenes-compra.md");
  if (existsSync(knowledgePath)) {
    systemContent +=
      "\n\n# CONOCIMIENTO DEL PROCESO Y REGLAS DE CONTROL:\n" +
      readFileSync(knowledgePath, "utf-8");
  }

  return systemContent;
}

/**
 * Construye el agente reactivo oficial usando `createAgent` de `langchain`,
 * herramientas definidas con `tool(...)` + `zod`, `MemorySaver` y `contextSchema`.
 */
export function buildSapPurchaseOrderAgent(params: {
  adapter: LlmAdapter;
  directory: string;
  checkpointer?: MemorySaver;
  maxIterations: number;
  onToolExecuted: (call: ExecutedToolCall) => void;
  onTokensUsed: (tokens: number) => void;
  getExecutedCount: () => number;
}) {
  const systemPrompt = loadSystemPrompt(params.directory);

  const model =
    params.adapter instanceof AIProvider
      ? params.adapter.getChatModel()
      : new AdapterChatModel(params.adapter);

  const turnControlMiddleware = createMiddleware({
    name: "SapOcTurnControlMiddleware",
    contextSchema,
    wrapModelCall: async (request, handler) => {
      if (params.getExecutedCount() >= params.maxIterations) {
        return new AIMessage({
          content: `Se ha alcanzado el límite máximo de ${params.maxIterations} iteraciones por turno. Estado parcial: se ejecutaron ${params.getExecutedCount()} llamadas a herramientas.`,
        });
      }

      if (params.getExecutedCount() === 0) {
        const agentMsgs = baseMessagesToAgentMessages(request.messages);
        const lastUserMsg = [...agentMsgs].reverse().find((m) => m.role === "user");
        if (lastUserMsg?.content && isOffTopicQuery(lastUserMsg.content)) {
          return new AIMessage({
            content: OFF_TOPIC_GUARDRAIL_REPLY,
          });
        }
      }

      try {
        const aiMsg = await handler(request);
        const totalTokens = aiMsg.usage_metadata?.total_tokens;
        if (typeof totalTokens === "number" && totalTokens > 0) {
          params.onTokensUsed(totalTokens);
        }
        const rawText =
          typeof aiMsg.content === "string"
            ? aiMsg.content
            : Array.isArray(aiMsg.content)
              ? aiMsg.content
                  .map((b) =>
                    typeof b === "string"
                      ? b
                      : typeof b === "object" && b !== null && "text" in b
                        ? String((b as { text?: unknown }).text ?? "")
                        : "",
                  )
                  .join("")
              : "";
        if (
          params.getExecutedCount() === 0 &&
          (!aiMsg.tool_calls || aiMsg.tool_calls.length === 0) &&
          OUTPUT_LEAKAGE_PATTERNS.test(rawText)
        ) {
          return new AIMessage({
            content: OFF_TOPIC_GUARDRAIL_REPLY,
          });
        }
        return aiMsg;
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes("MALFORMED_FUNCTION_CALL") || errMsg.includes("EmptyContentError")) {
          const fallback = await new DeterministicProvider().enviar(
            baseMessagesToAgentMessages(request.messages),
          );
          const lcToolCalls =
            fallback.tool_calls?.map((tc) => ({
              id: tc.id,
              name: tc.function.name,
              args: JSON.parse(tc.function.arguments),
              type: "tool_call" as const,
            })) ?? [];
          return new AIMessage({
            content: fallback.content ?? "",
            tool_calls: lcToolCalls,
          });
        }
        throw err;
      }
    },
    wrapToolCall: async (request, handler) => {
      const startMs = Date.now();
      const nowIso = new Date().toISOString();
      const tc = request.toolCall;
      const toolName = tc.name;
      const toolId = tc.id ?? `call_${Date.now()}`;
      const rawArgs = (tc.args ?? {}) as Record<string, unknown>;
      if (typeof rawArgs.confirmado === "boolean") {
        rawArgs.confirmado = rawArgs.confirmado ? "si" : "no";
        tc.args = rawArgs;
      }
      const sessionId = request.runtime.context?.sessionId ?? "default-session";
      const directory = request.runtime.context?.directory ?? params.directory;

      const registeredTool = (ocTools as Record<string, { args?: z.ZodRawShape }>)[toolName];

      if (!registeredTool) {
        const errorResult = { ok: false, error: `Herramienta desconocida: "${toolName}"` };
        const rawJson = JSON.stringify(errorResult);
        params.onToolExecuted({
          id: toolId,
          name: toolName,
          args: rawArgs,
          result: errorResult,
          rawResult: rawJson,
          durationMs: Date.now() - startMs,
          timestamp: nowIso,
        });
        appendLog(directory, {
          sessionId,
          ts: nowIso,
          tool: toolName,
          args: rawArgs,
          result: errorResult,
        });
        return new ToolMessage({
          name: toolName,
          tool_call_id: toolId,
          content: rawJson,
        });
      }

      if (registeredTool.args) {
        const validation = z.object(registeredTool.args).safeParse(rawArgs);
        if (!validation.success) {
          const errorResult = {
            ok: false,
            error: `Argumentos inválidos para ${toolName}: ${validation.error.issues.map((i) => i.message).join(", ")}`,
          };
          const rawJson = JSON.stringify(errorResult);
          params.onToolExecuted({
            id: toolId,
            name: toolName,
            args: rawArgs,
            result: errorResult,
            rawResult: rawJson,
            durationMs: Date.now() - startMs,
            timestamp: nowIso,
          });
          appendLog(directory, {
            sessionId,
            ts: nowIso,
            tool: toolName,
            args: rawArgs,
            result: errorResult,
          });
          return new ToolMessage({
            name: toolName,
            tool_call_id: toolId,
            content: rawJson,
          });
        }
      }

      const responseMsg = await handler(request);
      const durationMs = Date.now() - startMs;
      const rawContent =
        typeof responseMsg === "object" && responseMsg !== null && "content" in responseMsg
          ? typeof responseMsg.content === "string"
            ? responseMsg.content
            : JSON.stringify(responseMsg.content)
          : String(responseMsg);

      let parsedResult: { ok: boolean; data?: unknown; error?: unknown };
      try {
        parsedResult = JSON.parse(rawContent);
      } catch {
        parsedResult = { ok: false, error: rawContent };
      }

      params.onToolExecuted({
        id: toolId,
        name: toolName,
        args: rawArgs,
        result: parsedResult,
        rawResult: rawContent,
        durationMs,
        timestamp: nowIso,
      });

      appendLog(directory, {
        sessionId,
        ts: nowIso,
        tool: toolName,
        args: rawArgs,
        result: parsedResult,
      });

      return responseMsg;
    },
  });

  return createAgent({
    model,
    tools: langchainTools,
    checkpointer: params.checkpointer ?? memoryCheckpointer,
    contextSchema,
    systemPrompt,
    middleware: [turnControlMiddleware],
  });
}

export async function runAgentTurn(options: RunAgentTurnOptions): Promise<RunAgentTurnResult> {
  const directory = options.directory ?? process.cwd();
  const maxIterations = options.maxIterations ?? (Number(process.env.MAX_ITERATIONS) || 25);
  const threadId = options.threadId ?? options.sessionId ?? uuid7();

  const executedToolCalls: ExecutedToolCall[] = [];
  let needsConfirmation = false;
  let tokensUsed = 0;

  const agent = buildSapPurchaseOrderAgent({
    adapter: options.adapter,
    directory,
    checkpointer: options.checkpointer ?? memoryCheckpointer,
    maxIterations,
    getExecutedCount: () => executedToolCalls.length,
    onTokensUsed: (t) => {
      tokensUsed += t;
    },
    onToolExecuted: (call) => {
      executedToolCalls.push(call);

      if (call.name === "oc_validar" && call.result.ok) {
        const valData = call.result.data as {
          apta?: boolean;
          confirmaciones?: unknown[];
        } | null;
        if (
          valData?.apta === true &&
          Array.isArray(valData.confirmaciones) &&
          valData.confirmaciones.length > 0
        ) {
          needsConfirmation = true;
        }
      }

      if (call.name === "oc_crear") {
        if (call.result.ok) {
          needsConfirmation = false;
        } else if (String(call.result.error ?? "").toLowerCase().includes("confirmación")) {
          needsConfirmation = true;
        }
      }
    },
  });

  const threadConfig = {
    configurable: { thread_id: threadId },
    context: { directory, sessionId: threadId },
    recursionLimit: maxIterations * 3 + 10,
  };

  try {
    const result = await agent.invoke(
      {
        messages: [{ role: "user", content: options.userMessage }],
      },
      threadConfig,
    );

    const lastMessage = result.messages.at(-1);
    const reply =
      typeof lastMessage?.content === "string"
        ? lastMessage.content
        : Array.isArray(lastMessage?.content)
          ? lastMessage.content
              .map((b) =>
                typeof b === "string"
                  ? b
                  : typeof b === "object" && b !== null && "text" in b
                    ? String((b as { text?: unknown }).text ?? "")
                    : "",
              )
              .join("")
          : String(lastMessage?.content ?? "");

    const updatedHistory = baseMessagesToAgentMessages(result.messages);

    return {
      threadId,
      reply,
      toolCalls: executedToolCalls,
      needsConfirmation,
      updatedHistory,
      tokensUsed,
    };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      threadId,
      reply: `Error de comunicación con el proveedor LLM (timeout/fallo): ${errMsg}`,
      toolCalls: executedToolCalls,
      needsConfirmation: false,
      updatedHistory: options.history ?? [],
      tokensUsed,
      error: errMsg,
    };
  }
}
