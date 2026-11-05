import type { AgentMessage, ToolDefinition, LlmResponse } from "./adapter";
import { AIProvider } from "./base";

/**
 * Proveedor determinista local (Strategy Pattern).
 * Garantiza respuestas y secuencias de llamadas a herramientas 100% reproducibles
 * para los casos sol-001 a sol-006 sin requerir claves de API externas.
 */
export class DeterministicProvider extends AIProvider {
  readonly name = "deterministic";
  readonly model = "deterministic-sap-oc-v1";

  async enviar(mensajes: AgentMessage[], _herramientas?: ToolDefinition[]): Promise<LlmResponse> {
    let lastUserIndex = -1;
    for (let i = mensajes.length - 1; i >= 0; i--) {
      if (mensajes[i]?.role === "user") {
        lastUserIndex = i;
        break;
      }
    }

    const lastUserMsg = lastUserIndex >= 0 ? mensajes[lastUserIndex] : undefined;
    const userText = (lastUserMsg?.content ?? "").toLowerCase();

    let casoMatch = userText.match(/sol-\d{3}/i);
    if (!casoMatch) {
      for (let i = mensajes.length - 1; i >= 0; i--) {
        const m = mensajes[i]?.content?.match(/sol-\d{3}/i);
        if (m) {
          casoMatch = m;
          break;
        }
      }
    }
    const caso = casoMatch ? casoMatch[0].toLowerCase() : "sol-001";

    if (!casoMatch && !userText.includes("confirmo") && !userText.includes("proceder")) {
      return {
        content:
          "Soy el Agente de Órdenes de Compra SAP de Periferia IT. Indícame qué paquete deseas procesar (por ejemplo: `sol-001`, `sol-002`, `sol-003`, `sol-004`, `sol-005` o `sol-006`).",
        tool_calls: [],
      };
    }

    const toolMsgsForCase = mensajes.filter((m) => m.role === "tool");

    const pkgMsg = [...toolMsgsForCase].reverse().find((m) => {
      if (m.name !== "oc_leer_paquete") return false;
      return (m.content ?? "").toLowerCase().includes(caso);
    });

    if (!pkgMsg) {
      return {
        content: null,
        tool_calls: [
          {
            id: `det_read_${caso}`,
            type: "function",
            function: {
              name: "oc_leer_paquete",
              arguments: JSON.stringify({ caso }),
            },
          },
        ],
      };
    }

    let pkgData: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(pkgMsg.content || "{}");
      if (!parsed.ok) {
        return {
          content: `No pude procesar el caso **${caso}**: ${parsed.error}`,
          tool_calls: [],
        };
      }
      pkgData = parsed.data;
    } catch {
      return { content: `Error interpretando paquete de ${caso}.`, tool_calls: [] };
    }

    const valMsg = [...toolMsgsForCase].reverse().find((m) => m.name === "oc_validar");
    const pkgIdx = mensajes.lastIndexOf(pkgMsg);
    const valIdx = valMsg ? mensajes.lastIndexOf(valMsg) : -1;

    if (!valMsg || valIdx < pkgIdx) {
      return {
        content: null,
        tool_calls: [
          {
            id: `det_val_${caso}`,
            type: "function",
            function: {
              name: "oc_validar",
              arguments: JSON.stringify({ caso }),
            },
          },
        ],
      };
    }

    let valResult: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(valMsg.content || "{}");
      valResult = parsed.data;
    } catch {
      return { content: `Error leyendo validación de ${caso}.`, tool_calls: [] };
    }

    if (valResult && !valResult.apta) {
      const bloqueos = (valResult.bloqueos as Array<Record<string, string>> | undefined) ?? [];
      const detalle = bloqueos
        .map((b) => `• **[${b.codigo}]** ${b.detalle}\n  ↳ *Acción sugerida:* ${b.accion_sugerida}`)
        .join("\n");
      return {
        content: `### Solicitud ${caso.toUpperCase()} BLOQUEADA\nLa solicitud no cumple con las políticas obligatorias de control interno y **no puede crearse en SAP**:\n\n${detalle}`,
        tool_calls: [],
      };
    }

    const evMsg = [...toolMsgsForCase].reverse().find((m) => m.name === "oc_generar_evidencia");
    const evIdx = evMsg ? mensajes.lastIndexOf(evMsg) : -1;
    if (!evMsg || evIdx < pkgIdx) {
      return {
        content: null,
        tool_calls: [
          {
            id: `det_ev_${caso}`,
            type: "function",
            function: {
              name: "oc_generar_evidencia",
              arguments: JSON.stringify({ caso }),
            },
          },
        ],
      };
    }

    const payloadMsg = [...toolMsgsForCase].reverse().find((m) => m.name === "oc_construir_payload");
    const payloadIdx = payloadMsg ? mensajes.lastIndexOf(payloadMsg) : -1;
    if (!payloadMsg || payloadIdx < pkgIdx) {
      return {
        content: null,
        tool_calls: [
          {
            id: `det_payload_${caso}`,
            type: "function",
            function: {
              name: "oc_construir_payload",
              arguments: JSON.stringify({ caso }),
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

    const messagesSinceLastUser = lastUserIndex >= 0 ? mensajes.slice(lastUserIndex + 1) : mensajes;
    const createMsgInTurn = messagesSinceLastUser.find(
      (m) => m.role === "tool" && m.name === "oc_crear"
    );

    if (!createMsgInTurn) {
      return {
        content: null,
        tool_calls: [
          {
            id: `det_create_${caso}`,
            type: "function",
            function: {
              name: "oc_crear",
              arguments: JSON.stringify({
                caso,
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
      const pkgSolicitud = (pkgData?.solicitud as Record<string, unknown> | undefined) ?? {};
      const solicitante = String(pkgSolicitud.solicitante ?? "N/A");
      return {
        content: `${resumenTabla}\n• **Solicitante:** ${solicitante}\n\n### ✅ ¡Orden de Compra Registrada en SAP!\n• **Número OC SAP:** \`${String(createRes.data.numero_oc)}\`\n• **Fecha de Registro:** ${String(createRes.data.fecha)}\n• **Idempotencia:** ${createRes.data.idempotente ? "Orden existente reutilizada (idempotente = true)" : "Nueva orden creada (idempotente = false)"}\n• **Evidencia PDF:** \`out/${caso}/aprobacion.pdf\`\n• **Trazabilidad:** \`out/${caso}/trazabilidad.json\``,
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

export const MockProvider = DeterministicProvider;
export const HeuristicFallbackLlmAdapter = DeterministicProvider;
