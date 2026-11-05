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
  public readonly provider: string;
  public readonly model: string;

  constructor(config?: LangChainModelConfig) {
    this.config = config ?? {};
    const prov =
      this.config.provider ??
      (process.env.LLM_PROVIDER as "openai" | "google" | "anthropic" | undefined) ??
      "openai";
    this.provider = prov;
    if (prov === "google") {
      this.model = this.config.modelName ?? process.env.LLM_MODEL ?? process.env.GOOGLE_MODEL ?? "gemini-2.0-flash";
    } else if (prov === "anthropic") {
      this.model =
        this.config.modelName ?? process.env.LLM_MODEL ?? process.env.ANTHROPIC_MODEL ?? "claude-3-5-haiku-latest";
    } else {
      this.model = this.config.modelName ?? process.env.LLM_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini";
    }
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
  public readonly provider = "langchain-local-fallback";
  public readonly model = "deterministic-sap-agent-v1";

  async enviar(mensajes: AgentMessage[], _herramientas?: ToolDefinition[]): Promise<LlmResponse> {
    const lastUserIndex = mensajes.map((m) => m.role).lastIndexOf("user");
    const lastUser = lastUserIndex >= 0 ? mensajes[lastUserIndex] : undefined;
    const userText = lastUser?.content?.toLowerCase() ?? "";

    // Detectar si el usuario está rechazando
    if (userText.includes("no confirmo") || userText.includes("rechazar") || userText.includes("devuelve el caso")) {
      return {
        content:
          "Entendido. Se ha cancelado la creación de la Orden de Compra en SAP y se recomienda devolver el paquete al solicitante para ajustar las inconsistencias detectadas.",
        tool_calls: [],
      };
    }

    // Detectar caso mencionado en el último mensaje o recuperar el último caso leído en la sesión
    const casoMatch = userText.match(/\b(sol-\d{3})\b/i);
    let caso = casoMatch ? casoMatch[1]?.toLowerCase() : undefined;

    if (!caso) {
      for (let i = mensajes.length - 1; i >= 0; i--) {
        const m = mensajes[i];
        if (m?.role === "assistant" && m.tool_calls) {
          for (const tc of m.tool_calls) {
            try {
              const parsed = JSON.parse(tc.function.arguments);
              if (typeof parsed.caso === "string") {
                caso = parsed.caso;
                break;
              }
            } catch {}
          }
        }
        if (caso) break;
      }
    }
    caso = caso ?? "sol-001";

    // Buscar herramientas ya ejecutadas para este caso específico
    const toolMessagesForCase = mensajes.filter((m, idx) => {
      if (m.role !== "tool") return false;
      // Verificar si la llamada previa corresponde al caso activo
      for (let j = idx - 1; j >= 0; j--) {
        const prev = mensajes[j];
        if (prev?.role === "assistant" && prev.tool_calls) {
          const matchingCall = prev.tool_calls.find((tc) => tc.id === m.tool_call_id);
          if (matchingCall) {
            try {
              const args = JSON.parse(matchingCall.function.arguments);
              return args.caso === caso;
            } catch {
              return true;
            }
          }
        }
      }
      return true;
    });

    const readMsg = [...toolMessagesForCase].reverse().find((m) => m.name === "oc_leer_paquete");
    if (!readMsg) {
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

    let pkg: Record<string, unknown> = {};
    try {
      pkg = JSON.parse(readMsg.content || "{}").data ?? {};
    } catch {}

    const valMsg = [...toolMessagesForCase].reverse().find((m) => m.name === "oc_validar");
    if (!valMsg) {
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

    let valResult: Record<string, unknown> | null = null;
    try {
      valResult = JSON.parse(valMsg.content || "{}").data ?? null;
    } catch {}

    if (valResult && valResult.apta === false) {
      const bloqueos = (valResult.bloqueos as Array<Record<string, string>> | undefined) ?? [];
      const bloqueosDesc = bloqueos
        .map((b) => `• **[${b.codigo}]** ${b.detalle}\n  ↳ *Acción sugerida:* ${b.accion_sugerida}`)
        .join("\n");
      return {
        content: `La solicitud **${caso.toUpperCase()}** fue **BLOQUEADA** por control interno de compras:\n\n${bloqueosDesc}\n\nNo es posible generar la orden de compra en SAP hasta que se subsanen estos requisitos.`,
        tool_calls: [],
      };
    }

    // Generar evidencia de aprobación antes de construir el payload
    const evidMsg = [...toolMessagesForCase].reverse().find((m) => m.name === "oc_generar_evidencia");
    if (!evidMsg) {
      return {
        content: null,
        tool_calls: [
          {
            id: `call_evid_${Date.now()}`,
            type: "function",
            function: {
              name: "oc_generar_evidencia",
              arguments: JSON.stringify({ caso }),
            },
          },
        ],
      };
    }

    // Construir el payload SAP con trazabilidad
    const payloadMsg = [...toolMessagesForCase].reverse().find((m) => m.name === "oc_construir_payload");
    if (!payloadMsg) {
      return {
        content: null,
        tool_calls: [
          {
            id: `call_payload_${Date.now()}`,
            type: "function",
            function: {
              name: "oc_construir_payload",
              arguments: JSON.stringify({
                caso,
                paquete: pkg,
                derivados: (valResult?.derivados as Record<string, unknown>) ?? {},
              }),
            },
          },
        ],
      };
    }

    let payloadData: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(payloadMsg.content || "{}");
      payloadData = (parsed.data?.orden ?? parsed.data ?? {}) as Record<string, unknown>;
    } catch {}

    const confirmaciones = (valResult?.confirmaciones as Array<Record<string, string>> | undefined) ?? [];
    const hasConfirmationRules = confirmaciones.length > 0;
    const isExplicitlyAskingNotToCreateYet = userText.includes("no la crees");
    const isUserConfirming =
      !isExplicitlyAskingNotToCreateYet &&
      (userText.includes("confirmo") ||
        userText.includes("confirmar y crear") ||
        userText.includes("proceder") ||
        userText === "sí" ||
        userText === "si");

    const proveedorObj = (payloadData.proveedor as Record<string, string> | undefined) ?? {};
    const posicionesArr = (payloadData.posiciones as Array<Record<string, unknown>> | undefined) ?? [];
    const pos0 = posicionesArr[0] ?? {};
    const aprobadorObj = (payloadData.aprobador as Record<string, string> | undefined) ?? {};

    const resumenTabla = [
      `### Vista Previa del Payload SAP (${caso.toUpperCase()})`,
      `• **Sociedad / Org. Compras:** ${String(payloadData.sociedad ?? "1000")} / ${String(payloadData.organizacion_compras ?? "1000")}`,
      `• **Proveedor SAP:** ${proveedorObj.codigo_sap ?? "N/A"} — ${proveedorObj.nombre ?? ""} (NIT: ${proveedorObj.nit ?? ""})`,
      `• **Posición 10:** ${String(pos0.descripcion ?? "")} | Cant: ${String(pos0.cantidad ?? "")} ${String(pos0.unidad ?? "UN")} | Unitario: $${Number(pos0.precio_unitario ?? 0).toLocaleString("es-CO")} ${String(payloadData.moneda ?? "COP")}`,
      `• **Imputación:** Centro ${String(pos0.centro_costo ?? "")} (${String(pos0.subarea ?? "")}) | IVA: ${String(pos0.indicador_iva ?? "C1")} | Pago: ${String(payloadData.condiciones_pago ?? "Z030")}`,
      `• **Evidencia Aprobación (${aprobadorObj.email ?? ""}):** SHA-256 \`${String(aprobadorObj.evidencia_sha256 ?? "").slice(0, 16)}...\` (\`out/${caso}/aprobacion.pdf\`)`,
    ].join("\n");

    if (hasConfirmationRules && !isUserConfirming) {
      const confDesc = confirmaciones
        .map((c) => `• **[${c.codigo}]** ${c.detalle}\n  ↳ *Recomendación:* ${c.accion_sugerida}`)
        .join("\n");
      return {
        content: `${resumenTabla}\n\n### Validaciones y Confirmaciones Pendientes\nLa solicitud **${caso.toUpperCase()}** pasó los controles bloqueantes (RC1–RC4, RC10), pero requiere tu **confirmación explícita** antes de crear la OC en SAP:\n\n${confDesc}\n\n¿Confirmas la creación de la orden de compra bajo estas condiciones?`,
        tool_calls: [],
      };
    }

    // Verificar si ya ejecutamos oc_crear en este turno (después del último mensaje del usuario)
    const messagesSinceLastUser = lastUserIndex >= 0 ? mensajes.slice(lastUserIndex + 1) : mensajes;
    const createMsgInTurn = messagesSinceLastUser.find(
      (m) => m.role === "tool" && m.name === "oc_crear"
    );

    if (!createMsgInTurn) {
      return {
        content: null,
        tool_calls: [
          {
            id: `call_create_${Date.now()}`,
            type: "function",
            function: {
              name: "oc_crear",
              arguments: JSON.stringify({
                caso,
                payload: payloadData,
                confirmado: isUserConfirming || !hasConfirmationRules,
              }),
            },
          },
        ],
      };
    }

    let createRes: { ok?: boolean; data?: Record<string, unknown>; error?: string } = {};
    try {
      createRes = JSON.parse(createMsgInTurn.content || "{}");
    } catch {}

    if (createRes.ok && createRes.data) {
      return {
        content: `${resumenTabla}\n\n### ✅ ¡Orden de Compra Registrada en SAP!\n• **Número OC SAP:** \`${String(createRes.data.numero_oc)}\`\n• **Fecha de Registro:** ${String(createRes.data.fecha)}\n• **Idempotencia:** ${createRes.data.idempotente ? "Orden existente reutilizada (idempotente = true)" : "Nueva orden creada (idempotente = false)"}\n• **Evidencia PDF:** \`out/${caso}/aprobacion.pdf\`\n• **Trazabilidad:** \`out/${caso}/trazabilidad.json\``,
        tool_calls: [],
      };
    } else {
      return {
        content: `No se pudo crear la orden de compra: ${createRes.error ?? "Error desconocido"}`,
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
