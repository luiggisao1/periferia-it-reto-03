import { serve } from "bun";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, normalize } from "node:path";
import { runAgentTurn, type ExecutedToolCall, type AgentMessage } from "./agent/loop.ts";
import { createLlmAdapter } from "./llm/langchain.ts";

export interface SessionTurn {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  toolCalls?: ExecutedToolCall[];
  needsConfirmation?: boolean;
}

export interface SessionData {
  id: string;
  messages: AgentMessage[];
  turns: SessionTurn[];
  tokensUsed: number;
  createdAt: string;
  updatedAt: string;
}

const PORT = Number(process.env.PORT) || 3000;
const MAX_ITERATIONS = Number(process.env.MAX_ITERATIONS) || 25;
const MAX_SESSION_TOKENS = Number(process.env.MAX_SESSION_TOKENS) || 100000;
const OUT_DIR = join(process.cwd(), "out");
const SESSIONS_FILE = join(OUT_DIR, "sessions.json");

// Ensure out directory exists
if (!existsSync(OUT_DIR)) {
  mkdirSync(OUT_DIR, { recursive: true });
}

// In-memory sessions store
const sessions = new Map<string, SessionData>();

function loadSessions(): void {
  try {
    if (existsSync(SESSIONS_FILE)) {
      const raw = readFileSync(SESSIONS_FILE, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, SessionData>;
      for (const [id, data] of Object.entries(parsed)) {
        sessions.set(id, data);
      }
    }
  } catch (err) {
    console.error("No se pudieron cargar sesiones previas:", err);
  }
}

function saveSessions(): void {
  try {
    const obj: Record<string, SessionData> = {};
    for (const [id, data] of sessions.entries()) {
      obj[id] = data;
    }
    writeFileSync(SESSIONS_FILE, JSON.stringify(obj, null, 2), "utf-8");
  } catch (err) {
    console.error("Error guardando sesiones:", err);
  }
}

loadSessions();

// Initialize LLM adapter
const adapter = createLlmAdapter();

// Cached frontend JS bundle
let cachedBundleJs: string | null = null;

async function buildFrontendBundle(): Promise<string> {
  const entrypoint = join(process.cwd(), "web", "main.tsx");
  if (!existsSync(entrypoint)) {
    return "// web/main.tsx no encontrado";
  }
  const result = await Bun.build({
    entrypoints: [entrypoint],
    target: "browser",
    minify: false,
    sourcemap: "inline",
  });
  if (!result.success || result.outputs.length === 0) {
    const errorLogs = result.logs.map((l) => l.message).join("\n");
    throw new Error(`Fallo compilando web/main.tsx:\n${errorLogs}`);
  }
  const code = await result.outputs[0].text();
  cachedBundleJs = code;
  return code;
}

// 6 fixture cases definition for quick selection & inspection
const FIXTURE_CASES = [
  {
    id: "sol-001",
    label: "sol-001: Flujo Normal",
    solicitante: "Juan Camargo",
    proveedor: "TecnoSuministros S.A.S.",
    monto: "$11.400.000 COP",
    badge: "Normal",
    descripcion: "Renovación licencias antivirus corporativo 120 puestos. Cumple todas las reglas RC1-RC10 sin excepciones.",
    prompt: 'Procesa la solicitud "sol-001". Revisa todo el paquete, valida controles y crea la orden de compra en SAP si está apta.',
  },
  {
    id: "sol-002",
    label: "sol-002: Proveedor No Existe (RC1)",
    solicitante: "Diana Morales",
    proveedor: "CloudTech Solutions SAS (NIT 901999888)",
    monto: "$8.500.000 COP",
    badge: "Bloqueo",
    descripcion: "Consultoría arquitectura cloud. El proveedor no existe en maestros (RC1). Bloqueo automático sin crear OC.",
    prompt: 'Procesa la solicitud "sol-002". Valida controles e infórmame qué pasó con el proveedor.',
  },
  {
    id: "sol-003",
    label: "sol-003: Aprobador Sin Autoridad (RC3)",
    solicitante: "Carlos Mendoza",
    proveedor: "Hardware del Norte S.A.",
    monto: "$45.000.000 COP",
    badge: "Bloqueo",
    descripcion: "Servidores blade. El monto de $45M COP excede el límite de aprobación del líder ($30M en CC-1020). Bloqueo automático.",
    prompt: 'Procesa la solicitud "sol-003". Verifica el límite del aprobador contra el centro de costos.',
  },
  {
    id: "sol-004",
    label: "sol-004: Diferencia Cotización >2% (RC5)",
    solicitante: "Ana María Gómez",
    proveedor: "Oracle Support Colombia",
    monto: "$12.000.000 COP (Cotización: $13.200.000)",
    badge: "Confirmación",
    descripcion: "Soporte Oracle. Cotización difiere un 10% (>2% tolerancia RC5). Requiere confirmación humana antes de crear en SAP.",
    prompt: 'Procesa la solicitud "sol-004". Muéstrame la OC como quedaría en SAP, qué validaciones pasó y cuáles no, y no la crees hasta que yo lo confirme.',
  },
  {
    id: "sol-005",
    label: "sol-005: Factura Retroactiva (RC8)",
    solicitante: "Pedro Romero",
    proveedor: "Climas del Caribe Ltda.",
    monto: "$3.800.000 COP",
    badge: "Retroactiva",
    descripcion: "Mantenimiento aires. Factura emitida antes de la solicitud (RC8). Requiere confirmación humana y se marca retroactiva=true en control.csv.",
    prompt: 'Procesa la solicitud "sol-005". Detecta si es retroactiva y muéstrame el análisis de proceso.',
  },
  {
    id: "sol-006",
    label: "sol-006: IVA / Pago Derivados (RC6/RC7)",
    solicitante: "Laura Benítez",
    proveedor: "Data Insights S.A.S.",
    monto: "$7.200.000 COP",
    badge: "Derivado",
    descripcion: "Licencias analítica. Sin indicador de IVA ni condiciones de pago. Se derivan del proveedor y se pide confirmación de IVA.",
    prompt: 'Procesa la solicitud "sol-006". Deriva los valores faltantes desde el maestro de proveedores y confírmame.',
  },
];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
    },
  });
}

const server = serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // 1. Health check
    if (pathname === "/api/health" && req.method === "GET") {
      return jsonResponse({
        ok: true,
        provider: (adapter as { provider?: string }).provider ?? "auto",
        model: (adapter as { model?: string }).model ?? "default",
        maxIterations: MAX_ITERATIONS,
        maxSessionTokens: MAX_SESSION_TOKENS,
      });
    }

    // 2. Fixture cases and live audit logs
    if (pathname === "/api/cases" && req.method === "GET") {
      let controlLog = "";
      const controlFile = join(OUT_DIR, "control.csv");
      if (existsSync(controlFile)) {
        try {
          controlLog = readFileSync(controlFile, "utf-8");
        } catch {
          controlLog = "";
        }
      }

      const sapOrders: unknown[] = [];
      const ordenesFile = join(OUT_DIR, "sap", "ordenes.jsonl");
      if (existsSync(ordenesFile)) {
        try {
          const content = readFileSync(ordenesFile, "utf-8");
          const lines = content.split("\n").filter((l) => l.trim().length > 0);
          for (const line of lines) {
            try {
              sapOrders.push(JSON.parse(line));
            } catch {
              // ignore malformed line
            }
          }
        } catch {
          // ignore
        }
      }

      return jsonResponse({
        ok: true,
        cases: FIXTURE_CASES,
        controlLog,
        sapOrders,
      });
    }

    // 3. Get session
    if (pathname.startsWith("/api/sessions/") && req.method === "GET") {
      const sessionId = pathname.replace("/api/sessions/", "").trim();
      const session = sessions.get(sessionId);
      if (!session) {
        return jsonResponse({ ok: false, error: "Sesión no encontrada" }, 404);
      }
      return jsonResponse({ ok: true, session });
    }

    // 4. Delete / Reset session
    if (pathname.startsWith("/api/sessions/") && req.method === "DELETE") {
      const sessionId = pathname.replace("/api/sessions/", "").trim();
      if (sessions.has(sessionId)) {
        sessions.delete(sessionId);
        saveSessions();
      }
      return jsonResponse({ ok: true, message: "Sesión reiniciada con éxito" });
    }

    // 5. Chat endpoint
    if (pathname === "/api/chat" && req.method === "POST") {
      try {
        const body = (await req.json()) as { sessionId?: string; message?: string };
        const userMessage = (body.message ?? "").trim();
        if (!userMessage) {
          return jsonResponse({ ok: false, error: "El campo 'message' es obligatorio" }, 400);
        }

        const sessionId = body.sessionId && body.sessionId.trim().length > 0
          ? body.sessionId.trim()
          : `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        let session = sessions.get(sessionId);
        if (!session) {
          session = {
            id: sessionId,
            messages: [],
            turns: [],
            tokensUsed: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          sessions.set(sessionId, session);
        }

        // Enforce token budget limit
        if (session.tokensUsed >= MAX_SESSION_TOKENS) {
          const tokenReply = `⚠️ Se ha alcanzado el presupuesto máximo de tokens para esta sesión (${session.tokensUsed.toLocaleString()} / ${MAX_SESSION_TOKENS.toLocaleString()}). Por favor inicia una nueva sesión.`;
          return jsonResponse({
            ok: false,
            sessionId: session.id,
            reply: tokenReply,
            toolCalls: [],
            needsConfirmation: false,
            tokensUsed: session.tokensUsed,
          });
        }

        const turnResult = await runAgentTurn({
          sessionId: session.id,
          userMessage,
          history: session.messages,
          adapter,
          directory: process.cwd(),
          maxIterations: MAX_ITERATIONS,
          maxSessionTokens: MAX_SESSION_TOKENS,
          currentSessionTokens: session.tokensUsed,
        });

        session.messages = turnResult.updatedHistory;
        session.tokensUsed += turnResult.tokensUsed;
        session.updatedAt = new Date().toISOString();

        session.turns.push({
          role: "user",
          content: userMessage,
          timestamp: new Date().toISOString(),
        });

        session.turns.push({
          role: "assistant",
          content: turnResult.reply,
          timestamp: new Date().toISOString(),
          toolCalls: turnResult.toolCalls,
          needsConfirmation: turnResult.needsConfirmation,
        });

        saveSessions();

        return jsonResponse({
          ok: true,
          sessionId: session.id,
          reply: turnResult.reply,
          toolCalls: turnResult.toolCalls,
          needsConfirmation: turnResult.needsConfirmation,
          tokensUsed: session.tokensUsed,
        });
      } catch (err) {
        console.error("Error en POST /api/chat:", err);
        const errMsg = err instanceof Error ? err.message : String(err);
        return jsonResponse({
          ok: false,
          error: `Error interno procesando turno: ${errMsg}`,
          reply: `Ocurrió un error al procesar tu solicitud: ${errMsg}`,
          toolCalls: [],
          needsConfirmation: false,
        }, 500);
      }
    }

    // 6. Serve static files from out/ (aprobacion.txt, aprobacion.pdf, trazabilidad.json, control.csv)
    if (pathname.startsWith("/out/")) {
      const relPath = pathname.replace(/^\/out\//, "");
      const fullPath = resolve(OUT_DIR, normalize(relPath));
      // Guard against directory traversal
      if (!fullPath.startsWith(OUT_DIR)) {
        return new Response("Acceso denegado", { status: 403 });
      }
      if (!existsSync(fullPath)) {
        return new Response("Archivo no encontrado", { status: 404 });
      }

      let contentType = "application/octet-stream";
      if (fullPath.endsWith(".pdf")) contentType = "application/pdf";
      else if (fullPath.endsWith(".txt")) contentType = "text/plain; charset=utf-8";
      else if (fullPath.endsWith(".json") || fullPath.endsWith(".jsonl")) contentType = "application/json; charset=utf-8";
      else if (fullPath.endsWith(".csv")) contentType = "text/csv; charset=utf-8";

      const file = Bun.file(fullPath);
      return new Response(file, {
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "no-cache",
          ...CORS_HEADERS,
        },
      });
    }

    // 7. Serve styles.css
    if (pathname === "/styles.css") {
      const cssPath = join(process.cwd(), "web", "styles.css");
      if (existsSync(cssPath)) {
        return new Response(Bun.file(cssPath), {
          headers: { "Content-Type": "text/css; charset=utf-8" },
        });
      }
      return new Response("/* styles not found */", { status: 404 });
    }

    // 8. Serve compiled app.js
    if (pathname === "/app.js") {
      try {
        const bundle = cachedBundleJs ?? (await buildFrontendBundle());
        return new Response(bundle, {
          headers: { "Content-Type": "application/javascript; charset=utf-8" },
        });
      } catch (err) {
        console.error("Error compilando app.js:", err);
        return new Response(`console.error(${JSON.stringify(String(err))});`, {
          status: 500,
          headers: { "Content-Type": "application/javascript; charset=utf-8" },
        });
      }
    }

    // 9. Serve root index.html
    if (pathname === "/" || pathname === "/index.html") {
      const htmlPath = join(process.cwd(), "web", "index.html");
      if (existsSync(htmlPath)) {
        return new Response(Bun.file(htmlPath), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      return new Response("<h1>Reto 03 SAP OC Agent</h1><p>web/index.html no encontrado</p>", {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Ruta no encontrada", { status: 404 });
  },
});

console.log(`🚀 Agente SAP Órdenes de Compra activo en http://localhost:${PORT}`);
export { server };
