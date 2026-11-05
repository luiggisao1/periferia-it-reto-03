import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type {
  LlmAdapter,
  AgentMessage,
  ToolDefinition,
  LlmResponse,
} from "../llm/adapter";
import { ocTools } from "../tools/oc";

export type { AgentMessage };

export interface RunAgentTurnOptions {
  sessionId: string;
  userMessage: string;
  history?: AgentMessage[];
  adapter: LlmAdapter;
  directory?: string;
  maxIterations?: number;
  maxSessionTokens?: number;
  currentSessionTokens?: number;
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
  reply: string;
  toolCalls: ExecutedToolCall[];
  needsConfirmation: boolean;
  updatedHistory: AgentMessage[];
  tokensUsed: number;
  error?: string;
}

function buildToolDefinitions(): ToolDefinition[] {
  const definitions: ToolDefinition[] = [];

  for (const [toolName, tool] of Object.entries(ocTools)) {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [argName, argSchema] of Object.entries(tool.args)) {
      const isOptional = (argSchema as z.ZodTypeAny).isOptional();
      if (!isOptional) {
        required.push(argName);
      }
      properties[argName] = {
        type: "string",
        description: (argSchema as any).description ?? "",
      };
    }

    definitions.push({
      type: "function",
      function: {
        name: toolName,
        description: tool.description,
        parameters: {
          type: "object",
          properties,
          required: required.length > 0 ? required : undefined,
        },
      },
    });
  }

  return definitions;
}

function appendLog(
  directory: string,
  entry: {
    sessionId: string;
    ts: string;
    tool: string;
    args: unknown;
    result: unknown;
  }
) {
  const outDir = join(directory, "out");
  mkdirSync(outDir, { recursive: true });
  const logPath = join(outDir, "log.jsonl");
  appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
}

export async function runAgentTurn(options: RunAgentTurnOptions): Promise<RunAgentTurnResult> {
  const directory = options.directory ?? process.cwd();
  const maxIterations = options.maxIterations ?? (Number(process.env.MAX_ITERATIONS) || 25);
  const executedToolCalls: ExecutedToolCall[] = [];
  let needsConfirmation = false;
  let tokensUsed = 0;

  // 1. Cargar System Prompt y Conocimiento de proceso
  let systemContent =
    "Eres el Agente Especialista en Órdenes de Compra SAP para Periferia IT Group. Validas paquetes de compra contra maestros y controles internos.";

  const promptPath = join(directory, "agent", "prompt.md");
  if (existsSync(promptPath)) {
    systemContent = readFileSync(promptPath, "utf-8");
  }

  const knowledgePath = join(directory, "src", "knowledge", "ordenes-compra.md");
  if (existsSync(knowledgePath)) {
    systemContent += "\n\n# CONOCIMIENTO DEL PROCESO Y REGLAS DE CONTROL:\n" + readFileSync(knowledgePath, "utf-8");
  }

  // 2. Preparar historial de mensajes
  const messages: AgentMessage[] = [];
  if (options.history && options.history.length > 0) {
    const hasSystem = options.history.some((m) => m.role === "system");
    if (!hasSystem) {
      messages.push({ role: "system", content: systemContent });
    }
    messages.push(...options.history);
  } else {
    messages.push({ role: "system", content: systemContent });
  }

  messages.push({ role: "user", content: options.userMessage });

  const toolDefinitions = buildToolDefinitions();

  // 3. Ciclo del Agente (Tope de iteraciones CA1)
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    let response: LlmResponse;
    try {
      response = await options.adapter.enviar(messages, toolDefinitions);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        reply: `Error de comunicación con el proveedor LLM (timeout/fallo): ${errMsg}`,
        toolCalls: executedToolCalls,
        needsConfirmation: false,
        updatedHistory: messages,
        tokensUsed,
        error: errMsg,
      };
    }

    if (response.usage?.total_tokens) {
      tokensUsed += response.usage.total_tokens;
    }

    // Si el LLM devolvió respuesta sin tool_calls -> fin del turno
    if (!response.tool_calls || response.tool_calls.length === 0) {
      const reply = response.content || "";
      messages.push({ role: "assistant", content: reply });
      return {
        reply,
        toolCalls: executedToolCalls,
        needsConfirmation,
        updatedHistory: messages,
        tokensUsed,
      };
    }

    // Agregar llamada del asistente al historial
    messages.push({
      role: "assistant",
      content: response.content,
      tool_calls: response.tool_calls,
    });

    // Ejecutar cada tool_call solicitada
    for (const tc of response.tool_calls) {
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs =
          typeof tc.function.arguments === "string"
            ? JSON.parse(tc.function.arguments)
            : (tc.function.arguments as Record<string, unknown>);
      } catch {
        parsedArgs = {};
      }

      const tool = (ocTools as Record<string, any>)[tc.function.name];

      // CA5: Validación tipada de argumentos con Zod antes de ejecutar
      const startMs = Date.now();
      const nowIso = new Date().toISOString();

      if (!tool) {
        const errorResult = { ok: false, error: `Herramienta desconocida: "${tc.function.name}"` };
        executedToolCalls.push({
          id: tc.id,
          name: tc.function.name,
          args: parsedArgs,
          result: errorResult,
          durationMs: Date.now() - startMs,
          timestamp: nowIso,
        });
        appendLog(directory, {
          sessionId: options.sessionId,
          ts: nowIso,
          tool: tc.function.name,
          args: parsedArgs,
          result: errorResult,
        });
        messages.push({
          role: "tool",
          name: tc.function.name,
          tool_call_id: tc.id,
          content: JSON.stringify(errorResult),
        });
        continue;
      }

      const argSchema = z.object(tool.args);
      const validation = argSchema.safeParse(parsedArgs);

      if (!validation.success) {
        const errorResult = {
          ok: false,
          error: `Argumentos inválidos para ${tc.function.name}: ${validation.error.issues.map((i) => i.message).join(", ")}`,
        };
        executedToolCalls.push({
          id: tc.id,
          name: tc.function.name,
          args: parsedArgs,
          result: errorResult,
          durationMs: Date.now() - startMs,
          timestamp: nowIso,
        });
        appendLog(directory, {
          sessionId: options.sessionId,
          ts: nowIso,
          tool: tc.function.name,
          args: parsedArgs,
          result: errorResult,
        });
        messages.push({
          role: "tool",
          name: tc.function.name,
          tool_call_id: tc.id,
          content: JSON.stringify(errorResult),
        });
        continue;
      }

      // Ejecución segura de la herramienta
      const rawResult = await tool.execute(validation.data, {
        directory,
        sessionId: options.sessionId,
      });
      const durationMs = Date.now() - startMs;

      let parsedResult: { ok: boolean; data?: unknown; error?: unknown };
      try {
        parsedResult = JSON.parse(rawResult);
      } catch {
        parsedResult = { ok: false, error: rawResult };
      }

      executedToolCalls.push({
        id: tc.id,
        name: tc.function.name,
        args: validation.data as Record<string, unknown>,
        result: parsedResult,
        rawResult,
        durationMs,
        timestamp: nowIso,
      });

      appendLog(directory, {
        sessionId: options.sessionId,
        ts: new Date().toISOString(),
        tool: tc.function.name,
        args: validation.data,
        result: parsedResult,
      });

      messages.push({
        role: "tool",
        name: tc.function.name,
        tool_call_id: tc.id,
        content: rawResult,
      });

      // CA3: Rastrear necesidad de confirmación humana
      if (tc.function.name === "oc_validar" && parsedResult.ok) {
        const valData = parsedResult.data as any;
        if (
          valData?.apta === true &&
          Array.isArray(valData?.confirmaciones) &&
          valData.confirmaciones.length > 0
        ) {
          needsConfirmation = true;
        }
      }

      if (tc.function.name === "oc_crear") {
        if (parsedResult.ok) {
          needsConfirmation = false;
        } else if (String(parsedResult.error).toLowerCase().includes("confirmación")) {
          needsConfirmation = true;
        }
      }
    }
  }

  // Si se alcanzó el tope de iteraciones
  const reply = `Se ha alcanzado el límite máximo de ${maxIterations} iteraciones por turno. Estado parcial: se ejecutaron ${executedToolCalls.length} llamadas a herramientas sin converger a una respuesta final.`;
  messages.push({ role: "assistant", content: reply });

  return {
    reply,
    toolCalls: executedToolCalls,
    needsConfirmation,
    updatedHistory: messages,
    tokensUsed,
  };
}
