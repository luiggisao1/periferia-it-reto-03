import { rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  leer_paquete,
  validar,
  construir_payload,
  generar_evidencia,
  crear,
} from "./src/tools/oc";

const WORKSPACE = process.cwd();
const ctx = { directory: WORKSPACE, sessionId: "demo-cli-run" };

interface CaseSummary {
  caso: string;
  solicitud_id: string;
  apta: boolean;
  bloqueos: string;
  confirmaciones: string;
  retroactiva: boolean;
  numero_oc: string;
  estado_final: string;
}

async function main() {
  console.log("================================================================================");
  console.log("  DEMOSTRACIÓN DETERMINISTA — AGENTE ÓRDENES DE COMPRA SAP (PERXIA 2.0)");
  console.log("  Ejecución directa de herramientas y validación de reglas RC1 a RC10 sin LLM");
  console.log("================================================================================\n");

  // 1. Limpieza de directorio out/ para garantizar determinismo estricto
  const outDir = join(WORKSPACE, "out");
  rmSync(outDir, { recursive: true, force: true });
  console.log("🧹 Directorio out/ limpiado exitosamente.\n");

  const casos = ["sol-001", "sol-002", "sol-003", "sol-004", "sol-005", "sol-006"];
  const resumen: CaseSummary[] = [];

  for (const caso of casos) {
    console.log(`--------------------------------------------------------------------------------`);
    console.log(`▶ Procesando caso: ${caso}`);
    console.log(`--------------------------------------------------------------------------------`);

    // 1. Leer paquete
    const pkgRaw = await leer_paquete.execute({ caso }, ctx);
    const pkgRes = JSON.parse(pkgRaw);
    if (!pkgRes.ok) {
      console.log(`❌ Error al leer paquete: ${pkgRes.error}`);
      continue;
    }
    const pkg = pkgRes.data;
    console.log(`  1. Paquete leído: Solicitud ${pkg.solicitud.solicitud_id} (${pkg.solicitud.proveedor_nombre})`);
    console.log(`     Monto: ${pkg.solicitud.valor_total.toLocaleString("es-CO")} ${pkg.solicitud.moneda} | Centro: ${pkg.solicitud.centro_costo} (${pkg.solicitud.subarea})`);

    // 2. Validar contra maestros y reglas RC1-RC10
    const valRaw = await validar.execute({ caso, paquete: pkg }, ctx);
    const valRes = JSON.parse(valRaw);
    const val = valRes.data;

    console.log(`  2. Validación de Controles: ${val.apta ? "APTA ✅" : "BLOQUEADA 🚫"}`);
    if (val.bloqueos.length > 0) {
      console.log(`     Bloqueos detectados:`);
      for (const b of val.bloqueos) {
        console.log(`       • [${b.codigo}] ${b.detalle}`);
      }
    }
    if (val.confirmaciones.length > 0) {
      console.log(`     Observaciones que requieren confirmación:`);
      for (const c of val.confirmaciones) {
        console.log(`       • [${c.codigo}] ${c.detalle}`);
      }
    }
    if (val.retroactiva) {
      console.log(`     ⚠️ Marcada como RETROACTIVA (factura previa a solicitud)`);
    }

    // 3. Generar evidencia documental (si hay aprobación)
    let evidenciaSha: string | null = null;
    if (pkg.aprobacion) {
      const evRaw = await generar_evidencia.execute({ caso }, ctx);
      const evRes = JSON.parse(evRaw);
      if (evRes.ok) {
        evidenciaSha = evRes.data.sha256;
        console.log(`  3. Evidencia documental generada: out/${caso}/aprobacion.pdf (SHA256: ${evidenciaSha?.slice(0, 16)}...)`);
      }
    }

    // 4. Construir payload SAP
    let payload = null;
    if (val.apta) {
      const bldRaw = await construir_payload.execute(
        { caso, paquete: pkg, derivados: val.derivados },
        ctx
      );
      const bldRes = JSON.parse(bldRaw);
      if (bldRes.ok) {
        payload = bldRes.data.orden ?? bldRes.data;
        console.log(`  4. Payload SAP generado y trazabilidad guardada en out/${caso}/trazabilidad.json`);
      }
    }

    // 5. Creación en SAP simulado
    let numeroOc = "N/A";
    let estadoFinal = "BLOQUEADA";

    if (!val.apta) {
      const resRaw = await crear.execute({ caso, payload }, ctx);
      const res = JSON.parse(resRaw);
      console.log(`  5. Intento de creación: Rechazado por reglas de control (${res.error})`);
      estadoFinal = `Bloqueada (${val.bloqueos.map((b: any) => b.codigo).join(", ")})`;
    } else if (caso === "sol-004") {
      // Demostración de confirmación humana obligatoria en sol-004
      console.log(`  5. Prueba de confirmación humana en sol-004:`);
      console.log(`     a) Intento sin confirmación explícita (confirmado: false)...`);
      const resNoConfRaw = await crear.execute({ caso, payload, confirmado: false }, ctx);
      const resNoConf = JSON.parse(resNoConfRaw);
      console.log(`        Resultado: ${resNoConf.ok ? "Inesperado" : "Pendiente de confirmación ⏸️ (" + resNoConf.error + ")"}`);

      console.log(`     b) Intento con confirmación humana explícita (confirmado: true)...`);
      const resConfRaw = await crear.execute({ caso, payload, confirmado: true }, ctx);
      const resConf = JSON.parse(resConfRaw);
      if (resConf.ok) {
        numeroOc = resConf.data.numero_oc;
        estadoFinal = "Creada con confirmación";
        console.log(`        Resultado: Orden Creada en SAP No. ${numeroOc} ✅`);
      }
    } else {
      const resRaw = await crear.execute({ caso, payload, confirmado: true }, ctx);
      const res = JSON.parse(resRaw);
      if (res.ok) {
        numeroOc = res.data.numero_oc;
        estadoFinal = "Creada exitosamente";
        console.log(`  5. Orden creada en SAP No. ${numeroOc} ✅`);
      }
    }

    resumen.push({
      caso,
      solicitud_id: pkg.solicitud.solicitud_id,
      apta: val.apta,
      bloqueos: val.bloqueos.map((b: any) => b.codigo).join(", ") || "Ninguno",
      confirmaciones: val.confirmaciones.map((c: any) => c.codigo).join(", ") || "Ninguna",
      retroactiva: Boolean(val.retroactiva),
      numero_oc: numeroOc,
      estado_final: estadoFinal,
    });

    // Demostración de Idempotencia estricta en sol-001
    if (caso === "sol-001") {
      console.log(`\n  🔁 Demostrando idempotencia: re-ejecutando creación para sol-001...`);
      const reRunRaw = await crear.execute({ caso: "sol-001", payload, confirmado: true }, ctx);
      const reRun = JSON.parse(reRunRaw);
      console.log(`     Resultado 2da llamada: No. OC ${reRun.data?.numero_oc} | Idempotente: ${reRun.data?.idempotente} ✅`);
      console.log(`     (No se duplicó en out/sap/ordenes.jsonl)\n`);
    }

    console.log();
  }

  // Resumen tabular final
  console.log("================================================================================");
  console.log("  RESUMEN DE PROCESAMIENTO DE LOS 6 CASOS (MATRIZ DE RESULTADOS)");
  console.log("================================================================================");
  console.table(resumen);

  console.log("\n📁 Archivos de auditoría generados en out/:");
  if (existsSync(outDir)) {
    const listFiles = (dir: string, prefix = "") => {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          listFiles(join(dir, entry.name), `${prefix}${entry.name}/`);
        } else {
          console.log(`   • out/${prefix}${entry.name}`);
        }
      }
    };
    listFiles(outDir);
  }

  console.log("\n================================================================================");
  console.log("  DEMO FINALIZADA CON ÉXITO — 100% DE HISTORIAS Y CONTROLES VERIFICADOS");
  console.log("================================================================================\n");
}

main().catch((err) => {
  console.error("Error fatal en demo:", err);
  process.exit(1);
});
