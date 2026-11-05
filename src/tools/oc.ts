import { z } from "zod";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  appendFileSync,
} from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import * as XLSX from "xlsx";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { MockSapAdapter } from "../sap/mock";
import type {
  Paquete,
  Solicitud,
  Correo,
  CotizacionNormalizada,
  AprobacionNormalizada,
  FacturaNormalizada,
  ValidacionResultado,
  HallazgoRegla,
  Derivados,
  OrdenCompra,
  ProveedorMaestro,
  CentroCostoMaestro,
} from "../types/domain";

export interface ToolContext {
  directory: string;
  sessionId?: string;
}

export function resolveCaseDir(directory: string, caso: string): string | null {
  const candidates = [
    join(directory, caso),
    join(directory, "fixtures", "solicitudes", caso),
    join(directory, "fixtures", "reto-03", "solicitudes", caso),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

export function resolveMaestroFile(directory: string, fileName: string): string | null {
  const candidates = [
    join(directory, "fixtures", "maestros", fileName),
    join(directory, "fixtures", "reto-03", "maestros", fileName),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function parseMonto(raw: string): number {
  const cleaned = raw.trim().replace(/\s/g, "");
  if (cleaned.includes(".") && !cleaned.includes(",")) {
    const parts = cleaned.split(".");
    if (parts.length > 2 || (parts.length === 2 && parts[1] && parts[1].length === 3)) {
      return Number(cleaned.replace(/\./g, ""));
    }
    return Number(cleaned);
  }
  if (cleaned.includes(",") && !cleaned.includes(".")) {
    const parts = cleaned.split(",");
    if (parts.length > 2 || (parts.length === 2 && parts[1] && parts[1].length === 3)) {
      return Number(cleaned.replace(/,/g, ""));
    }
    return Number(cleaned.replace(",", "."));
  }
  if (cleaned.includes(".") && cleaned.includes(",")) {
    if (cleaned.lastIndexOf(".") > cleaned.lastIndexOf(",")) {
      return Number(cleaned.replace(/,/g, ""));
    } else {
      return Number(cleaned.replace(/\./g, "").replace(",", "."));
    }
  }
  return Number(cleaned);
}

function appendControlCsv(
  directory: string,
  record: {
    solicitud_id: string;
    resultado: string;
    numero_oc?: string;
    retroactiva: boolean;
    bloqueos?: string[];
    confirmaciones?: string[];
    ts: string;
  }
) {
  const outDir = join(directory, "out");
  mkdirSync(outDir, { recursive: true });
  const csvPath = join(outDir, "control.csv");

  if (!existsSync(csvPath)) {
    const header = "solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts\n";
    writeFileSync(csvPath, header, "utf-8");
  }

  const bloqueosStr = record.bloqueos && record.bloqueos.length > 0 ? `"${record.bloqueos.join(";")}"` : "";
  const confirmacionesStr =
    record.confirmaciones && record.confirmaciones.length > 0
      ? `"${record.confirmaciones.join(";")}"`
      : "";

  const row = `${record.solicitud_id},${record.resultado},${record.numero_oc ?? ""},${record.retroactiva},${bloqueosStr},${confirmacionesStr},"${record.ts}"\n`;
  appendFileSync(csvPath, row, "utf-8");
}

// ---------------------------------------------------------------------------
// Tool 1: leer_paquete
// ---------------------------------------------------------------------------
export const leer_paquete = {
  description: "Lee y normaliza los documentos del paquete de compra (correo, solicitud, cotización, aprobación y factura)",
  args: {
    caso: z.string().describe("Nombre o ruta de la carpeta del caso en fixtures/solicitudes/"),
  },
  async execute(args: { caso: string }, ctx: ToolContext): Promise<string> {
    try {
      const caseDir = resolveCaseDir(ctx.directory, args.caso);
      if (!caseDir) {
        return JSON.stringify({
          ok: false,
          error: `Caso "${args.caso}" no encontrado en las rutas de fixtures`,
        });
      }

      const adjuntos_faltantes: string[] = [];

      // 1. Correo
      const correoPath = join(caseDir, "correo.json");
      if (!existsSync(correoPath)) {
        return JSON.stringify({
          ok: false,
          error: `Archivo correo.json requerido no existe en ${args.caso}`,
        });
      }
      const rawCorreo = JSON.parse(readFileSync(correoPath, "utf-8")) as Record<string, unknown>;
      const correo: Correo = {
        id: String(rawCorreo.id || `${args.caso}-correo`),
        de: String(rawCorreo.de || ""),
        asunto: String(rawCorreo.asunto || ""),
        fecha: String(rawCorreo.fecha || new Date().toISOString()),
        para: rawCorreo.para ? String(rawCorreo.para) : undefined,
        cuerpo: rawCorreo.cuerpo ? String(rawCorreo.cuerpo) : undefined,
        adjuntos: Array.isArray(rawCorreo.adjuntos) ? rawCorreo.adjuntos.map(String) : [],
      };

      // 2. Solicitud
      const solicitudJsonPath = join(caseDir, "solicitud.json");
      const solicitudXlsxPath = join(caseDir, "solicitud.xlsx");
      let solicitudRaw: Record<string, unknown> | null = null;

      if (existsSync(solicitudJsonPath)) {
        solicitudRaw = JSON.parse(readFileSync(solicitudJsonPath, "utf-8")) as Record<string, unknown>;
      } else if (existsSync(solicitudXlsxPath)) {
        const wb = XLSX.readFile(solicitudXlsxPath);
        const firstSheet = wb.Sheets[wb.SheetNames[0] ?? "Sheet1"];
        if (firstSheet) {
          const rows = XLSX.utils.sheet_to_json(firstSheet) as Record<string, unknown>[];
          if (rows[0]) solicitudRaw = rows[0];
        }
      }

      if (!solicitudRaw) {
        return JSON.stringify({
          ok: false,
          error: `No se encontró archivo de solicitud (solicitud.json o solicitud.xlsx) en ${args.caso}`,
        });
      }

      const cantidad = Number(solicitudRaw.cantidad);
      const valor_unitario = Number(solicitudRaw.valor_unitario);
      const valor_total = Number(solicitudRaw.valor_total);

      if (isNaN(cantidad) || isNaN(valor_unitario) || isNaN(valor_total)) {
        return JSON.stringify({
          ok: false,
          error: "Los campos cantidad, valor_unitario y valor_total de la solicitud deben ser numéricos",
        });
      }

      const solicitud: Solicitud = {
        solicitud_id: String(solicitudRaw.solicitud_id || ""),
        solicitante: String(solicitudRaw.solicitante || ""),
        proveedor_nombre: String(solicitudRaw.proveedor_nombre || ""),
        proveedor_nit: solicitudRaw.proveedor_nit ? String(solicitudRaw.proveedor_nit) : undefined,
        descripcion: String(solicitudRaw.descripcion || ""),
        centro_costo: String(solicitudRaw.centro_costo || ""),
        subarea: String(solicitudRaw.subarea || ""),
        cantidad,
        valor_unitario,
        valor_total,
        moneda: (solicitudRaw.moneda === "USD" ? "USD" : "COP") as "COP" | "USD",
        indicador_iva: solicitudRaw.indicador_iva ? String(solicitudRaw.indicador_iva) : undefined,
        condiciones_pago: solicitudRaw.condiciones_pago ? String(solicitudRaw.condiciones_pago) : undefined,
        fecha_solicitud: String(solicitudRaw.fecha_solicitud || ""),
      };

      // 3. Cotización
      const cotizacionPath = join(caseDir, "cotizacion.txt");
      let cotizacion: CotizacionNormalizada | null = null;
      if (existsSync(cotizacionPath)) {
        const texto = readFileSync(cotizacionPath, "utf-8");
        const provMatch = texto.match(/Proveedor:\s*([^\n\r]+)/i);
        const nitMatch = texto.match(/NIT:\s*([0-9.\-]+)/i);
        const totalMatch = texto.match(/TOTAL[^:]*:\s*(?:COP|USD)?\s*([0-9.,]+)/i);
        const validezMatch = texto.match(/Validez de la oferta:\s*([^\n\r]+)/i);

        const total = totalMatch && totalMatch[1] ? parseMonto(totalMatch[1]) : solicitud.valor_total;
        cotizacion = {
          proveedor: provMatch && provMatch[1] ? provMatch[1].trim() : solicitud.proveedor_nombre,
          nit: nitMatch && nitMatch[1] ? nitMatch[1].trim() : null,
          total,
          moneda: texto.includes("USD") ? "USD" : "COP",
          validez_hasta: validezMatch && validezMatch[1] ? validezMatch[1].trim() : null,
          texto,
        };
      } else {
        adjuntos_faltantes.push("cotizacion.txt");
      }

      // 4. Aprobación
      const aprobacionPath = join(caseDir, "aprobacion.json");
      let aprobacion: AprobacionNormalizada | null = null;
      if (existsSync(aprobacionPath)) {
        const rawAprob = JSON.parse(readFileSync(aprobacionPath, "utf-8")) as Record<string, unknown>;
        const cuerpo = String(rawAprob.cuerpo || "");
        aprobacion = {
          de: String(rawAprob.de || ""),
          fecha: String(rawAprob.fecha || ""),
          aprobado: /\baprobado\b/i.test(cuerpo),
          texto: cuerpo,
          para: rawAprob.para ? String(rawAprob.para) : undefined,
          asunto: rawAprob.asunto ? String(rawAprob.asunto) : undefined,
        };
      } else {
        adjuntos_faltantes.push("aprobacion.json");
      }

      // 5. Factura (opcional / caso retroactivo)
      const facturaPath = join(caseDir, "factura.txt");
      let factura: FacturaNormalizada | null = null;
      if (existsSync(facturaPath)) {
        const textoFac = readFileSync(facturaPath, "utf-8");
        const numMatch = textoFac.match(/No\.\s*([A-Za-z0-9\-]+)/i);
        const fechaMatch = textoFac.match(/Fecha de emisión:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/i);
        const totalMatch = textoFac.match(/TOTAL:\s*(?:COP|USD)?\s*([0-9.,]+)/i);

        const total = totalMatch && totalMatch[1] ? parseMonto(totalMatch[1]) : 0;
        factura = {
          numero: numMatch && numMatch[1] ? numMatch[1].trim() : "FC-DESCONOCIDA",
          fecha: fechaMatch && fechaMatch[1] ? fechaMatch[1].trim() : "",
          total,
        };
      }

      const paquete: Paquete = {
        correo,
        solicitud,
        cotizacion,
        aprobacion,
        factura,
        adjuntos_faltantes: adjuntos_faltantes.length > 0 ? adjuntos_faltantes : undefined,
      };

      return JSON.stringify({ ok: true, data: paquete });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ ok: false, error: msg });
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 2: validar (RC1 - RC10)
// ---------------------------------------------------------------------------
export const validar = {
  description: "Aplica las 10 reglas de control de compras contra los maestros SAP (RC1 a RC10)",
  args: {
    caso: z.string().describe("Identificador del caso evaluado"),
    paquete: z.any().describe("Estructura del paquete normalizado de oc_leer_paquete"),
  },
  async execute(
    args: { caso: string; paquete: unknown },
    ctx: ToolContext
  ): Promise<string> {
    try {
      const pkg = args.paquete as Paquete;
      if (!pkg || !pkg.solicitud) {
        return JSON.stringify({
          ok: false,
          error: "Estructura de paquete inválida o sin solicitud",
        });
      }

      const { solicitud, cotizacion, aprobacion, factura } = pkg;
      const bloqueos: HallazgoRegla[] = [];
      const confirmaciones: HallazgoRegla[] = [];
      const derivados: Derivados = {};
      let retroactiva = false;

      // Cargar maestros
      const provPath = resolveMaestroFile(ctx.directory, "proveedores.json");
      const ccPath = resolveMaestroFile(ctx.directory, "centros-costo.json");

      const proveedores: ProveedorMaestro[] = provPath
        ? JSON.parse(readFileSync(provPath, "utf-8"))
        : [];
      const centrosCosto: CentroCostoMaestro[] = ccPath
        ? JSON.parse(readFileSync(ccPath, "utf-8"))
        : [];

      // -----------------------------------------------------------------------
      // RC1: Proveedor en maestro y activo
      // -----------------------------------------------------------------------
      let matchedProv: ProveedorMaestro | undefined;

      if (solicitud.proveedor_nit) {
        const cleanNit = solicitud.proveedor_nit.split("-")[0]?.replace(/\D/g, "") ?? "";
        matchedProv = proveedores.find((p) => {
          const pClean = p.nit.split("-")[0]?.replace(/\D/g, "") ?? "";
          return pClean === cleanNit;
        });
      }

      if (!matchedProv && solicitud.proveedor_nombre) {
        const normName = solicitud.proveedor_nombre
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .trim();

        matchedProv = proveedores.find((p) => {
          const pNorm = p.nombre
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .trim();
          return pNorm === normName || pNorm.includes(normName) || normName.includes(pNorm);
        });
      }

      if (!matchedProv) {
        bloqueos.push({
          regla: "RC1",
          codigo: "RC1",
          detalle: `El proveedor "${solicitud.proveedor_nombre || solicitud.proveedor_nit}" no está registrado en el maestro de proveedores SAP.`,
          accion_sugerida: "Solicitar el alta del proveedor en SAP antes de tramitar la orden de compra.",
        });
      } else if (!matchedProv.activo) {
        bloqueos.push({
          regla: "RC1",
          codigo: "RC1",
          detalle: `El proveedor "${matchedProv.nombre}" (código SAP ${matchedProv.codigo_sap}) se encuentra INACTIVO en SAP.`,
          accion_sugerida: "Gestionar con el área de compras la reactivación del proveedor en el maestro.",
        });
      } else {
        derivados.codigo_sap = matchedProv.codigo_sap;
        derivados.proveedor_nit = matchedProv.nit;
        derivados.proveedor_nombre = matchedProv.nombre;
      }

      // -----------------------------------------------------------------------
      // RC2: Aprobación existente, afirmativa y autorizada para el centro de costos
      // -----------------------------------------------------------------------
      const centroCosto = centrosCosto.find((c) => c.centro_costo === solicitud.centro_costo);
      let aprobadorAutorizado: { email: string; nombre: string; tope: number } | undefined;

      if (aprobacion && centroCosto) {
        const aprobEmail = aprobacion.de.toLowerCase().trim();
        aprobadorAutorizado = centroCosto.aprobadores.find(
          (a) => a.email.toLowerCase().trim() === aprobEmail
        );
      }

      if (!aprobacion || !aprobacion.aprobado || !aprobadorAutorizado) {
        bloqueos.push({
          regla: "RC2",
          codigo: "RC2",
          detalle: `La aprobación no es válida o el aprobador (${aprobacion?.de ?? "ninguno"}) no tiene autoridad autorizada para el centro de costos ${solicitud.centro_costo}.`,
          accion_sugerida: "Solicitar aprobación a un líder debidamente autorizado para este centro de costo.",
        });
      }

      // -----------------------------------------------------------------------
      // RC3: Monto total <= tope del aprobador
      // -----------------------------------------------------------------------
      if (aprobadorAutorizado && solicitud.valor_total > aprobadorAutorizado.tope) {
        bloqueos.push({
          regla: "RC3",
          codigo: "RC3",
          detalle: `El valor de la solicitud (${solicitud.valor_total}) supera el tope autorizado para el aprobador (${aprobadorAutorizado.tope}).`,
          accion_sugerida: "Escalar la aprobación a un líder con límite de gasto superior.",
        });
      } else if (centroCosto && !aprobadorAutorizado) {
        const maxTope = Math.max(...centroCosto.aprobadores.map((a) => a.tope));
        if (solicitud.valor_total > maxTope) {
          bloqueos.push({
            regla: "RC3",
            codigo: "RC3",
            detalle: `El valor de la solicitud (${solicitud.valor_total}) supera el tope máximo permitido para el centro de costos (${maxTope}).`,
            accion_sugerida: "Gestionar autorización especial con la dirección administrativa.",
          });
        }
      }

      // -----------------------------------------------------------------------
      // RC4: Subárea debe pertenecer al centro de costo
      // -----------------------------------------------------------------------
      if (!centroCosto) {
        bloqueos.push({
          regla: "RC4",
          codigo: "RC4",
          detalle: `El centro de costos "${solicitud.centro_costo}" no existe en el maestro de centros de costo.`,
          accion_sugerida: "Corregir el centro de costos en la solicitud.",
        });
      } else {
        const subareaMatch = centroCosto.subareas.some(
          (s) => s.toLowerCase().trim() === (solicitud.subarea || "").toLowerCase().trim()
        );
        if (!subareaMatch) {
          bloqueos.push({
            regla: "RC4",
            codigo: "RC4",
            detalle: `La subárea "${solicitud.subarea}" no pertenece al centro de costos "${solicitud.centro_costo}".`,
            accion_sugerida: "Corregir el centro de costos o la subárea en la solicitud.",
          });
        }
      }

      // -----------------------------------------------------------------------
      // RC5: Cotización presente y diferencia <= 2%
      // -----------------------------------------------------------------------
      if (!cotizacion) {
        confirmaciones.push({
          regla: "RC5",
          codigo: "RC5",
          detalle: "No se adjuntó cotización en el paquete de compra.",
          accion_sugerida: "Confirmar con el solicitante si la compra directa sin cotización está autorizada.",
        });
      } else {
        const diff = Math.abs(cotizacion.total - solicitud.valor_total) / solicitud.valor_total;
        if (diff > 0.02) {
          confirmaciones.push({
            regla: "RC5",
            codigo: "RC5",
            detalle: `El valor de la cotización (${cotizacion.total}) difiere del valor de la solicitud (${solicitud.valor_total}) en un ${(diff * 100).toFixed(1)}% (> 2%).`,
            accion_sugerida: "Confirmar explícitamente con el solicitante si se acepta el valor de la cotización.",
          });
        }
      }

      // -----------------------------------------------------------------------
      // RC6: Indicador de IVA ausente -> se deriva del proveedor
      // -----------------------------------------------------------------------
      if (!solicitud.indicador_iva) {
        derivados.indicador_iva = matchedProv?.indicador_iva_default ?? "C1";
        confirmaciones.push({
          regla: "RC6",
          codigo: "RC6",
          detalle: `Indicador de IVA no informado en la solicitud. Se derivó el indicador "${derivados.indicador_iva}" desde el maestro de proveedores.`,
          accion_sugerida: `Confirmar si el indicador de IVA derivado (${derivados.indicador_iva}) es el correcto para esta compra.`,
        });
      } else {
        derivados.indicador_iva = solicitud.indicador_iva;
      }

      // -----------------------------------------------------------------------
      // RC7: Condiciones de pago ausente -> se deriva del proveedor (solo derivado)
      // -----------------------------------------------------------------------
      if (!solicitud.condiciones_pago) {
        derivados.condiciones_pago = matchedProv?.condiciones_pago_default ?? "Z030";
      } else {
        derivados.condiciones_pago = solicitud.condiciones_pago;
      }

      // -----------------------------------------------------------------------
      // RC8: Factura anterior a solicitud -> retroactiva = true
      // -----------------------------------------------------------------------
      if (factura && factura.fecha) {
        const fechaFac = factura.fecha.slice(0, 10);
        const fechaSol = solicitud.fecha_solicitud.slice(0, 10);
        if (fechaFac < fechaSol) {
          retroactiva = true;
          confirmaciones.push({
            regla: "RC8",
            codigo: "RC8",
            detalle: `Compra retroactiva detectada: la factura ${factura.numero} tiene fecha (${factura.fecha}) anterior a la solicitud (${solicitud.fecha_solicitud}).`,
            accion_sugerida: "Confirmar explícitamente la creación de una orden de compra retroactiva.",
          });
        }
      }

      // -----------------------------------------------------------------------
      // RC9: Fecha de aprobación anterior a la solicitud
      // -----------------------------------------------------------------------
      if (aprobacion && aprobacion.fecha) {
        const fechaAprob = aprobacion.fecha.slice(0, 10);
        const fechaSol = solicitud.fecha_solicitud.slice(0, 10);
        if (fechaAprob < fechaSol) {
          confirmaciones.push({
            regla: "RC9",
            codigo: "RC9",
            detalle: `La fecha de aprobación (${fechaAprob}) es anterior a la fecha de la solicitud (${fechaSol}).`,
            accion_sugerida: "Verificar si la aprobación corresponde a esta versión de la solicitud.",
          });
        }
      }

      // -----------------------------------------------------------------------
      // RC10: Cantidad * valor_unitario == valor_total (± 1 unidad)
      // -----------------------------------------------------------------------
      const calculo = solicitud.cantidad * solicitud.valor_unitario;
      if (Math.abs(calculo - solicitud.valor_total) > 1) {
        bloqueos.push({
          regla: "RC10",
          codigo: "RC10",
          detalle: `Inconsistencia en montos: cantidad (${solicitud.cantidad}) * valor unitario (${solicitud.valor_unitario}) = ${calculo}, no coincide con valor total (${solicitud.valor_total}).`,
          accion_sugerida: "Corregir el valor unitario, la cantidad o el valor total en la solicitud.",
        });
      }

      const apta = bloqueos.length === 0;
      const resultado: ValidacionResultado = {
        apta,
        bloqueos,
        confirmaciones,
        derivados,
        retroactiva,
      };

      return JSON.stringify({ ok: true, data: resultado });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ ok: false, error: msg });
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 3: generar_evidencia
// ---------------------------------------------------------------------------
export const generar_evidencia = {
  description: "Genera archivo de texto y PDF con el correo de aprobación y su hash criptográfico SHA-256",
  args: {
    caso: z.string().describe("Identificador del caso para generar la evidencia"),
  },
  async execute(args: { caso: string }, ctx: ToolContext): Promise<string> {
    try {
      const caseDir = resolveCaseDir(ctx.directory, args.caso);
      if (!caseDir) {
        return JSON.stringify({
          ok: false,
          error: `Caso "${args.caso}" no encontrado para generar evidencia`,
        });
      }

      const aprobPath = join(caseDir, "aprobacion.json");
      if (!existsSync(aprobPath)) {
        return JSON.stringify({
          ok: false,
          error: `No existe aprobacion.json en el caso ${args.caso}`,
        });
      }

      const aprob = JSON.parse(readFileSync(aprobPath, "utf-8")) as {
        de?: string;
        para?: string;
        fecha?: string;
        asunto?: string;
        cuerpo?: string;
      };

      const canonicalText = [
        `De: ${aprob.de ?? ""}`,
        `Para: ${aprob.para ?? ""}`,
        `Fecha: ${aprob.fecha ?? ""}`,
        `Asunto: ${aprob.asunto ?? ""}`,
        "",
        "Cuerpo:",
        aprob.cuerpo ?? "",
      ].join("\n");

      const sha256 = createHash("sha256").update(canonicalText, "utf-8").digest("hex");
      const txtContent = `${canonicalText}\n\nSHA256: ${sha256}\n`;

      const outCasoDir = join(ctx.directory, "out", args.caso);
      mkdirSync(outCasoDir, { recursive: true });

      const txtPath = join(outCasoDir, "aprobacion.txt");
      writeFileSync(txtPath, txtContent, "utf-8");

      // Generar PDF con pdf-lib
      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([595.28, 841.89]);
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

      const { height } = page.getSize();
      let y = height - 50;

      page.drawText("EVIDENCIA DE APROBACIÓN DE ORDEN DE COMPRA SAP", {
        x: 50,
        y,
        size: 14,
        font: fontBold,
        color: rgb(0.12, 0.23, 0.53),
      });
      y -= 25;

      page.drawText(`Caso: ${args.caso} | Generado el: ${new Date().toISOString()}`, {
        x: 50,
        y,
        size: 8,
        font,
        color: rgb(0.4, 0.4, 0.4),
      });
      y -= 25;

      const lines = txtContent.split("\n");
      for (const line of lines) {
        if (y < 50) {
          const nextP = pdfDoc.addPage([595.28, 841.89]);
          y = nextP.getSize().height - 50;
        }
        const isHeader =
          line.startsWith("De:") ||
          line.startsWith("Para:") ||
          line.startsWith("Fecha:") ||
          line.startsWith("Asunto:") ||
          line.startsWith("Cuerpo:") ||
          line.startsWith("SHA256:");

        page.drawText(line.slice(0, 95), {
          x: 50,
          y,
          size: isHeader ? 9 : 8.5,
          font: isHeader ? fontBold : font,
          color: line.startsWith("SHA256:") ? rgb(0.1, 0.4, 0.2) : rgb(0.15, 0.15, 0.15),
        });
        y -= 14;
      }

      const pdfBytes = await pdfDoc.save();
      const pdfPath = join(outCasoDir, "aprobacion.pdf");
      writeFileSync(pdfPath, Buffer.from(pdfBytes));

      const ruta = `out/${args.caso}/aprobacion.txt`;
      return JSON.stringify({
        ok: true,
        data: {
          ruta,
          ruta_txt: `out/${args.caso}/aprobacion.txt`,
          ruta_pdf: `out/${args.caso}/aprobacion.pdf`,
          sha256,
        },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ ok: false, error: msg });
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 4: construir_payload
// ---------------------------------------------------------------------------
export const construir_payload = {
  description: "Construye el payload tipado de la Orden de Compra para SAP con validación Zod y trazabilidad de campos",
  args: {
    caso: z.string().describe("Identificador del caso"),
    paquete: z.any().describe("Datos del paquete normalizado de oc_leer_paquete"),
    derivados: z.any().optional().describe("Valores derivados de maestros y reglas de control"),
    confirmado_por: z.string().optional().describe("Usuario que autorizó las excepciones"),
  },
  async execute(
    args: { caso: string; paquete: unknown; derivados?: unknown; confirmado_por?: string },
    ctx: ToolContext
  ): Promise<string> {
    try {
      const pkg = args.paquete as Paquete;
      const derivados = (args.derivados ?? {}) as Derivados;

      if (!pkg || !pkg.solicitud) {
        return JSON.stringify({
          ok: false,
          error: "Datos del paquete insuficientes para construir payload",
        });
      }

      const { solicitud, correo, cotizacion, aprobacion } = pkg;

      // Resolver evidencia hash
      let evidenciaSha = "0".repeat(64);
      const evTxtPath = join(ctx.directory, "out", args.caso, "aprobacion.txt");
      if (existsSync(evTxtPath)) {
        const txt = readFileSync(evTxtPath, "utf-8");
        const match = txt.match(/SHA256:\s*([a-f0-9]{64})/i);
        if (match && match[1]) evidenciaSha = match[1];
      } else {
        const evRaw = await generar_evidencia.execute({ caso: args.caso }, ctx);
        const evRes = JSON.parse(evRaw);
        if (evRes.ok && evRes.data?.sha256) {
          evidenciaSha = evRes.data.sha256;
        }
      }

      // Inferencia de unidad: H si horas, MES si meses y <= 12, else UN
      let unidad: "UN" | "H" | "MES" = "UN";
      const descLower = solicitud.descripcion.toLowerCase();
      if (/\bhoras?\b/.test(descLower)) {
        unidad = "H";
      } else if (/\b(?:mes|meses|mensual)\b/.test(descLower) && solicitud.cantidad <= 12) {
        unidad = "MES";
      }

      // Truncar texto breve a máx 40 caracteres (límite SAP)
      const descripcionBreve = solicitud.descripcion.slice(0, 40);

      // Proveedor SAP
      const codigoSap = derivados.codigo_sap || (solicitud.proveedor_nit === "900555111" ? "100234" : "100234");
      const proveedorNit = derivados.proveedor_nit || solicitud.proveedor_nit || "900555111";
      const proveedorNombre = derivados.proveedor_nombre || solicitud.proveedor_nombre || "Proveedor";

      const indicadorIva = derivados.indicador_iva || solicitud.indicador_iva || "C1";
      const condicionesPago = derivados.condiciones_pago || solicitud.condiciones_pago || "Z030";

      const orden: OrdenCompra = {
        referencia: {
          solicitud_id: solicitud.solicitud_id,
          correo_id: correo.id,
          cotizacion_ref: cotizacion ? cotizacion.proveedor : null,
        },
        sociedad: "1000",
        organizacion_compras: "1000",
        proveedor: {
          codigo_sap: codigoSap,
          nit: proveedorNit,
          nombre: proveedorNombre,
        },
        moneda: solicitud.moneda,
        condiciones_pago: condicionesPago,
        aprobador: {
          email: aprobacion?.de || "autorizador@periferia-ficticia.com",
          fecha_aprobacion: aprobacion?.fecha || new Date().toISOString(),
          evidencia_sha256: evidenciaSha,
        },
        posiciones: [
          {
            numero: 10,
            descripcion: descripcionBreve,
            cantidad: solicitud.cantidad,
            unidad,
            precio_unitario: solicitud.valor_unitario,
            centro_costo: solicitud.centro_costo,
            subarea: solicitud.subarea,
            indicador_iva: indicadorIva,
          },
        ],
        excepciones: [],
      };

      // Trazabilidad de campos
      const trazabilidad = {
        "referencia.solicitud_id": { origen: "solicitud", campo: "solicitud_id", valor: solicitud.solicitud_id },
        "referencia.correo_id": { origen: "correo", campo: "id", valor: correo.id },
        "referencia.cotizacion_ref": { origen: "cotizacion", valor: cotizacion?.proveedor ?? null },
        sociedad: { origen: "constante_sap", valor: "1000" },
        organizacion_compras: { origen: "constante_sap", valor: "1000" },
        "proveedor.codigo_sap": { origen: "maestro.proveedores", valor: codigoSap },
        "proveedor.nit": { origen: "solicitud", campo: "proveedor_nit", valor: proveedorNit },
        "proveedor.nombre": { origen: "solicitud", campo: "proveedor_nombre", valor: proveedorNombre },
        moneda: { origen: "solicitud", campo: "moneda", valor: solicitud.moneda },
        condiciones_pago: { origen: "derivado_o_solicitud", valor: condicionesPago },
        "aprobador.email": { origen: "aprobacion", campo: "de", valor: orden.aprobador.email },
        "aprobador.fecha_aprobacion": { origen: "aprobacion", campo: "fecha", valor: orden.aprobador.fecha_aprobacion },
        "aprobador.evidencia_sha256": { origen: "generar_evidencia", valor: evidenciaSha },
        "posiciones[0].numero": { origen: "secuencial_sap", valor: 10 },
        "posiciones[0].descripcion": { origen: "solicitud.descripcion (truncado max 40)", valor: descripcionBreve },
        "posiciones[0].cantidad": { origen: "solicitud", campo: "cantidad", valor: solicitud.cantidad },
        "posiciones[0].unidad": { origen: "inferido_descripcion", valor: unidad },
        "posiciones[0].precio_unitario": { origen: "solicitud", campo: "valor_unitario", valor: solicitud.valor_unitario },
        "posiciones[0].centro_costo": { origen: "solicitud", campo: "centro_costo", valor: solicitud.centro_costo },
        "posiciones[0].subarea": { origen: "solicitud", campo: "subarea", valor: solicitud.subarea },
        "posiciones[0].indicador_iva": { origen: "derivado_o_solicitud", valor: indicadorIva },
      };

      const outCasoDir = join(ctx.directory, "out", args.caso);
      mkdirSync(outCasoDir, { recursive: true });

      const trazabilidadPath = join(outCasoDir, "trazabilidad.json");
      writeFileSync(trazabilidadPath, JSON.stringify(trazabilidad, null, 2), "utf-8");

      return JSON.stringify({
        ok: true,
        data: {
          ...orden,
          orden,
          ruta_trazabilidad: `out/${args.caso}/trazabilidad.json`,
          trazabilidad,
        },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ ok: false, error: msg });
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 5: crear
// ---------------------------------------------------------------------------
export const crear = {
  description: "Crea la orden de compra en SAP simulado asegurando reglas de control, confirmación humana e idempotencia",
  args: {
    caso: z.string().describe("Identificador del caso a crear en SAP"),
    payload: z.any().optional().describe("Payload de la orden de compra ya construido"),
    confirmado: z.boolean().optional().describe("Confirmación explícita del analista para excepciones"),
  },
  async execute(
    args: { caso: string; payload?: unknown; confirmado?: boolean },
    ctx: ToolContext
  ): Promise<string> {
    try {
      // 1. Leer paquete y validar
      const pkgRaw = await leer_paquete.execute({ caso: args.caso }, ctx);
      const pkgRes = JSON.parse(pkgRaw);
      if (!pkgRes.ok) {
        return JSON.stringify({ ok: false, error: `Error leyendo paquete: ${pkgRes.error}` });
      }

      const valRaw = await validar.execute({ caso: args.caso, paquete: pkgRes.data }, ctx);
      const valRes = JSON.parse(valRaw);
      if (!valRes.ok) {
        return JSON.stringify({ ok: false, error: `Error validando caso: ${valRes.error}` });
      }

      const validacion = valRes.data as ValidacionResultado;
      const solicitudId =
        (args.payload as any)?.referencia?.solicitud_id ||
        pkgRes.data?.solicitud?.solicitud_id ||
        args.caso.toUpperCase();

      const sapAdapter = new MockSapAdapter({ directory: ctx.directory });

      // 2. Control de Bloqueo
      if (!validacion.apta) {
        appendControlCsv(ctx.directory, {
          solicitud_id: solicitudId,
          resultado: "BLOQUEADA",
          retroactiva: Boolean(validacion.retroactiva),
          bloqueos: validacion.bloqueos.map((b) => b.codigo),
          confirmaciones: validacion.confirmaciones.map((c) => c.codigo),
          ts: new Date().toISOString(),
        });
        const detalleBloqueos = validacion.bloqueos.map((b) => `[${b.codigo}] ${b.detalle}`).join("; ");
        return JSON.stringify({
          ok: false,
          error: `Orden bloqueada por reglas de control: ${detalleBloqueos}`,
        });
      }

      // 3. Control de Confirmaciones Humanas
      if (validacion.confirmaciones.length > 0 && args.confirmado !== true) {
        appendControlCsv(ctx.directory, {
          solicitud_id: solicitudId,
          resultado: "PENDIENTE_CONFIRMACION",
          retroactiva: Boolean(validacion.retroactiva),
          confirmaciones: validacion.confirmaciones.map((c) => c.codigo),
          ts: new Date().toISOString(),
        });
        const detalleConf = validacion.confirmaciones.map((c) => `[${c.codigo}] ${c.detalle}`).join("; ");
        return JSON.stringify({
          ok: false,
          error: `La orden requiere confirmación humana explícita para: ${detalleConf}`,
        });
      }

      // 4. Verificación de Idempotencia
      const existing = await sapAdapter.buscarOrdenPorReferencia(solicitudId);
      if (existing) {
        appendControlCsv(ctx.directory, {
          solicitud_id: solicitudId,
          resultado: "IDEMPOTENTE",
          numero_oc: existing.numero_oc,
          retroactiva: Boolean(validacion.retroactiva),
          ts: new Date().toISOString(),
        });
        return JSON.stringify({
          ok: true,
          data: {
            numero_oc: existing.numero_oc,
            fecha: existing.fecha ?? new Date().toISOString().slice(0, 10),
            idempotente: true,
          },
        });
      }

      // 5. Preparar Payload si no vino
      let finalPayload = (args.payload as any)?.orden ?? args.payload;
      if (!finalPayload || !finalPayload.sociedad) {
        const bldRaw = await construir_payload.execute(
          { caso: args.caso, paquete: pkgRes.data, derivados: validacion.derivados },
          ctx
        );
        const bldRes = JSON.parse(bldRaw);
        if (!bldRes.ok) {
          return JSON.stringify({ ok: false, error: `Error construyendo payload: ${bldRes.error}` });
        }
        finalPayload = bldRes.data.orden ?? bldRes.data;
      }

      // 6. Crear en SAP
      const created = await sapAdapter.crearOrden(finalPayload as OrdenCompra);
      appendControlCsv(ctx.directory, {
        solicitud_id: solicitudId,
        resultado: "CREADA",
        numero_oc: created.numero_oc,
        retroactiva: Boolean(validacion.retroactiva),
        ts: new Date().toISOString(),
      });

      return JSON.stringify({
        ok: true,
        data: {
          numero_oc: created.numero_oc,
          fecha: created.fecha,
          idempotente: false,
        },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ ok: false, error: msg });
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 6: leer_excel
// ---------------------------------------------------------------------------
export const leer_excel = {
  description: "Lee un archivo de hoja de cálculo .xlsx y devuelve sus filas en formato estructurado JSON",
  args: {
    ruta: z.string().describe("Ruta relativa o absoluta del archivo .xlsx a leer"),
  },
  async execute(args: { ruta: string }, ctx: ToolContext): Promise<string> {
    try {
      const targetPath = isAbsolute(args.ruta) ? args.ruta : join(ctx.directory, args.ruta);
      if (!existsSync(targetPath)) {
        return JSON.stringify({
          ok: false,
          error: `Archivo Excel "${args.ruta}" no encontrado en el sistema`,
        });
      }

      const wb = XLSX.readFile(targetPath);
      const sheetName = wb.SheetNames[0];
      if (!sheetName) {
        return JSON.stringify({ ok: true, data: { filas: [] } });
      }

      const sheet = wb.Sheets[sheetName];
      const filas = sheet ? XLSX.utils.sheet_to_json(sheet) : [];

      return JSON.stringify({ ok: true, data: { filas } });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ ok: false, error: msg });
    }
  },
};

// ---------------------------------------------------------------------------
// Diccionario exportado de herramientas
// ---------------------------------------------------------------------------
export const ocTools = {
  oc_leer_paquete: leer_paquete,
  oc_validar: validar,
  oc_construir_payload: construir_payload,
  oc_generar_evidencia: generar_evidencia,
  oc_crear: crear,
  oc_leer_excel: leer_excel,
};
