import { describe, it, expect, beforeEach } from "bun:test";
import { rmSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import * as XLSX from "xlsx";
import {
  leer_paquete,
  validar,
  construir_payload,
  generar_evidencia,
  crear,
  leer_excel,
} from "../tools/oc";
import { MockSapAdapter } from "../sap/mock";

const WORKSPACE_DIR = process.cwd();
const ctx = { directory: WORKSPACE_DIR, sessionId: "test-session-oc" };

function hasRule(list: any[] | undefined, code: string): boolean {
  if (!list || !Array.isArray(list)) return false;
  return list.some(
    (item) =>
      item === code ||
      item?.regla === code ||
      item?.codigo === code ||
      JSON.stringify(item).includes(code)
  );
}

describe("Tools OC Contract & Business Rules", () => {
  beforeEach(() => {
    rmSync(join(WORKSPACE_DIR, "out"), { recursive: true, force: true });
  });

  describe("1. Contract & Metadata Verification", () => {
    const tools = [
      { name: "leer_paquete", tool: leer_paquete },
      { name: "validar", tool: validar },
      { name: "construir_payload", tool: construir_payload },
      { name: "generar_evidencia", tool: generar_evidencia },
      { name: "crear", tool: crear },
      { name: "leer_excel", tool: leer_excel },
    ];

    for (const { name, tool } of tools) {
      it(`tool ${name} complies with the standard tool shape and metadata`, () => {
        expect(typeof tool.description).toBe("string");
        expect(tool.description.trim().length).toBeGreaterThan(10);
        expect(typeof tool.args).toBe("object");
        expect(typeof tool.execute).toBe("function");

        for (const [argName, schema] of Object.entries(tool.args)) {
          expect((schema as any).description).toBeDefined();
          expect(typeof (schema as any).description).toBe("string");
          expect((schema as any).description.trim().length).toBeGreaterThan(0);
        }
      });
    }
  });

  describe("2. HU-1 (leer_paquete & leer_excel)", () => {
    it("reads and normalizes sol-001 (happy path complete package)", async () => {
      const raw = await leer_paquete.execute({ caso: "sol-001" }, ctx);
      const res = JSON.parse(raw);

      expect(res.ok).toBe(true);
      expect(res.data.correo).toBeDefined();
      expect(res.data.correo.asunto).toContain("SOL-001");
      expect(res.data.solicitud).toBeDefined();
      expect(res.data.solicitud.solicitud_id).toBe("SOL-2026-001");
      expect(res.data.solicitud.valor_total).toBe(11400000);
      expect(res.data.cotizacion).toBeDefined();
      expect(res.data.cotizacion.total).toBe(11400000);
      expect(res.data.cotizacion.nit).toMatch(/900\.?555\.?111/);
      expect(res.data.aprobacion).toBeDefined();
      expect(res.data.aprobacion.aprobado).toBe(true);
      expect(res.data.aprobacion.de).toBe("mlopez@periferia-ficticia.com");
      expect(res.data.factura).toBeNull();
    });

    it("reads sol-005 and extracts invoice data", async () => {
      const raw = await leer_paquete.execute({ caso: "sol-005" }, ctx);
      const res = JSON.parse(raw);

      expect(res.ok).toBe(true);
      expect(res.data.factura).toBeDefined();
      expect(res.data.factura.numero).toBe("FC-88231");
      expect(res.data.factura.fecha).toBe("2026-08-10");
      expect(res.data.factura.total).toBe(3200000);
    });

    it("returns error without throwing on non-existent case sol-999", async () => {
      const raw = await leer_paquete.execute({ caso: "sol-999" }, ctx);
      const res = JSON.parse(raw);

      expect(res.ok).toBe(false);
      expect(typeof res.error).toBe("string");
    });

    it("handles missing optional attachments gracefully without throwing", async () => {
      const mockDir = join(WORKSPACE_DIR, "out", "mock-cases", "sol-optional-test");
      mkdirSync(mockDir, { recursive: true });

      const correoMock = {
        id: "msg-test-01",
        de: "user@periferia-ficticia.com",
        asunto: "Solicitud sin cotizacion",
        fecha: "2026-08-20",
        cuerpo: "Por favor comprar directo",
        adjuntos: ["solicitud.json", "aprobacion.json"],
      };
      const solicitudMock = {
        solicitud_id: "SOL-OPT-001",
        solicitante: "Test User",
        proveedor_nombre: "TecnoSuministros S.A.S.",
        proveedor_nit: "900555111",
        descripcion: "Suscripcion directa",
        centro_costo: "CC-1010",
        subarea: "Soporte",
        cantidad: 1,
        valor_unitario: 100000,
        valor_total: 100000,
        moneda: "COP",
        fecha_solicitud: "2026-08-20",
      };
      const aprobacionMock = {
        de: "mlopez@periferia-ficticia.com",
        para: "user@periferia-ficticia.com",
        fecha: "2026-08-21T10:00:00-05:00",
        asunto: "Aprobado",
        cuerpo: "Aprobado",
      };

      await Bun.write(join(mockDir, "correo.json"), JSON.stringify(correoMock));
      await Bun.write(join(mockDir, "solicitud.json"), JSON.stringify(solicitudMock));
      await Bun.write(join(mockDir, "aprobacion.json"), JSON.stringify(aprobacionMock));

      const raw = await leer_paquete.execute(
        { caso: "out/mock-cases/sol-optional-test" },
        ctx
      );
      const res = JSON.parse(raw);

      expect(res.ok).toBe(true);
      expect(res.data.cotizacion).toBeNull();
      expect(res.data.factura).toBeNull();
      expect(res.data.solicitud.solicitud_id).toBe("SOL-OPT-001");
    });

    it("leer_excel reads sheet rows correctly from .xlsx file", async () => {
      const tmpExcelPath = join(WORKSPACE_DIR, "out", "tmp-test.xlsx");
      mkdirSync(dirname(tmpExcelPath), { recursive: true });

      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.json_to_sheet([
        { item: 1, descripcion: "Laptop Dev", valor: 5000000 },
        { item: 2, descripcion: "Monitor 4K", valor: 850000 },
      ]);
      XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
      XLSX.writeFile(wb, tmpExcelPath);

      const raw = await leer_excel.execute({ ruta: tmpExcelPath }, ctx);
      const res = JSON.parse(raw);

      expect(res.ok).toBe(true);
      expect(Array.isArray(res.data.filas)).toBe(true);
      expect(res.data.filas.length).toBe(2);
      expect(res.data.filas[0].descripcion).toBe("Laptop Dev");
      expect(res.data.filas[1].valor).toBe(850000);
    });
  });

  describe("3. HU-2 (validar — Control Rules RC1 to RC10)", () => {
    it("sol-001: happy path passes validation with zero blocks and confirmations", async () => {
      const pkgRaw = await leer_paquete.execute({ caso: "sol-001" }, ctx);
      const pkg = JSON.parse(pkgRaw).data;

      const raw = await validar.execute({ caso: "sol-001", paquete: pkg }, ctx);
      const res = JSON.parse(raw);

      expect(res.ok).toBe(true);
      expect(res.data.apta).toBe(true);
      expect(res.data.bloqueos.length).toBe(0);
      expect(res.data.confirmaciones.length).toBe(0);
      expect(Boolean(res.data.retroactiva)).toBe(false);
    });

    it("sol-002: triggers RC1 block for unlisted provider NIT", async () => {
      const pkgRaw = await leer_paquete.execute({ caso: "sol-002" }, ctx);
      const pkg = JSON.parse(pkgRaw).data;

      const raw = await validar.execute({ caso: "sol-002", paquete: pkg }, ctx);
      const res = JSON.parse(raw);

      expect(res.ok).toBe(true);
      expect(res.data.apta).toBe(false);
      expect(hasRule(res.data.bloqueos, "RC1")).toBe(true);
    });

    it("RC1 block: triggers when provider is inactive (Consultores Ágiles)", async () => {
      const pkgRaw = await leer_paquete.execute({ caso: "sol-001" }, ctx);
      const pkg = JSON.parse(pkgRaw).data;

      pkg.solicitud.proveedor_nit = "901777888";
      pkg.solicitud.proveedor_nombre = "Consultores Ágiles S.A.S.";

      const raw = await validar.execute({ caso: "sol-001", paquete: pkg }, ctx);
      const res = JSON.parse(raw);

      expect(res.ok).toBe(true);
      expect(res.data.apta).toBe(false);
      expect(hasRule(res.data.bloqueos, "RC1")).toBe(true);
    });

    it("sol-003: triggers RC2 block when approver does not belong to cost center", async () => {
      const pkgRaw = await leer_paquete.execute({ caso: "sol-003" }, ctx);
      const pkg = JSON.parse(pkgRaw).data;

      const raw = await validar.execute({ caso: "sol-003", paquete: pkg }, ctx);
      const res = JSON.parse(raw);

      expect(res.ok).toBe(true);
      expect(res.data.apta).toBe(false);
      expect(hasRule(res.data.bloqueos, "RC2")).toBe(true);
    });

    it("RC3 block: triggers when total amount exceeds cost center approver limit", async () => {
      const pkgRaw = await leer_paquete.execute({ caso: "sol-001" }, ctx);
      const pkg = JSON.parse(pkgRaw).data;

      pkg.solicitud.cantidad = 1;
      pkg.solicitud.valor_unitario = 60000000;
      pkg.solicitud.valor_total = 60000000;
      if (pkg.cotizacion) pkg.cotizacion.total = 60000000;

      const raw = await validar.execute({ caso: "sol-001", paquete: pkg }, ctx);
      const res = JSON.parse(raw);

      expect(res.ok).toBe(true);
      expect(res.data.apta).toBe(false);
      expect(hasRule(res.data.bloqueos, "RC3")).toBe(true);
    });

    it("RC4 block: triggers when subarea does not belong to cost center", async () => {
      const pkgRaw = await leer_paquete.execute({ caso: "sol-001" }, ctx);
      const pkg = JSON.parse(pkgRaw).data;

      pkg.solicitud.subarea = "Marketing"; // Marketing is in CC-3030, not CC-1010

      const raw = await validar.execute({ caso: "sol-001", paquete: pkg }, ctx);
      const res = JSON.parse(raw);

      expect(res.ok).toBe(true);
      expect(res.data.apta).toBe(false);
      expect(hasRule(res.data.bloqueos, "RC4")).toBe(true);
    });

    it("sol-004: triggers RC5 confirmation when quote exceeds request by > 2%", async () => {
      const pkgRaw = await leer_paquete.execute({ caso: "sol-004" }, ctx);
      const pkg = JSON.parse(pkgRaw).data;

      const raw = await validar.execute({ caso: "sol-004", paquete: pkg }, ctx);
      const res = JSON.parse(raw);

      expect(res.ok).toBe(true);
      expect(res.data.apta).toBe(true);
      expect(res.data.bloqueos.length).toBe(0);
      expect(hasRule(res.data.confirmaciones, "RC5")).toBe(true);
    });

    it("sol-005: triggers RC8 confirmation and sets retroactiva = true", async () => {
      const pkgRaw = await leer_paquete.execute({ caso: "sol-005" }, ctx);
      const pkg = JSON.parse(pkgRaw).data;

      const raw = await validar.execute({ caso: "sol-005", paquete: pkg }, ctx);
      const res = JSON.parse(raw);

      expect(res.ok).toBe(true);
      expect(res.data.apta).toBe(true);
      expect(res.data.retroactiva).toBe(true);
      expect(hasRule(res.data.confirmaciones, "RC8")).toBe(true);
    });

    it("sol-006: matches provider by name, derives IVA with RC6 confirmation, and derives payment terms (RC7)", async () => {
      const pkgRaw = await leer_paquete.execute({ caso: "sol-006" }, ctx);
      const pkg = JSON.parse(pkgRaw).data;

      const raw = await validar.execute({ caso: "sol-006", paquete: pkg }, ctx);
      const res = JSON.parse(raw);

      expect(res.ok).toBe(true);
      expect(res.data.apta).toBe(true);
      expect(res.data.derivados).toBeDefined();
      expect(res.data.derivados.indicador_iva).toBe("C1");
      expect(res.data.derivados.condiciones_pago).toBe("Z030");
      expect(hasRule(res.data.confirmaciones, "RC6")).toBe(true);
    });

    it("RC9 confirmation: triggers when approval date is prior to request date", async () => {
      const pkgRaw = await leer_paquete.execute({ caso: "sol-001" }, ctx);
      const pkg = JSON.parse(pkgRaw).data;

      pkg.solicitud.fecha_solicitud = "2026-08-20";
      pkg.aprobacion.fecha = "2026-08-15T10:00:00-05:00";

      const raw = await validar.execute({ caso: "sol-001", paquete: pkg }, ctx);
      const res = JSON.parse(raw);

      expect(res.ok).toBe(true);
      expect(res.data.apta).toBe(true);
      expect(hasRule(res.data.confirmaciones, "RC9")).toBe(true);
    });

    it("RC10 block: triggers when cantidad * valor_unitario != valor_total (diff > 1)", async () => {
      const pkgRaw = await leer_paquete.execute({ caso: "sol-001" }, ctx);
      const pkg = JSON.parse(pkgRaw).data;

      pkg.solicitud.cantidad = 10;
      pkg.solicitud.valor_unitario = 10000;
      pkg.solicitud.valor_total = 120000; // 10 * 10000 = 100000 != 120000

      const raw = await validar.execute({ caso: "sol-001", paquete: pkg }, ctx);
      const res = JSON.parse(raw);

      expect(res.ok).toBe(true);
      expect(res.data.apta).toBe(false);
      expect(hasRule(res.data.bloqueos, "RC10")).toBe(true);
    });
  });

  describe("4. HU-3 & HU-4 (generar_evidencia & construir_payload)", () => {
    it("generar_evidencia generates TXT and PDF evidence with sha256 for sol-001", async () => {
      const raw = await generar_evidencia.execute({ caso: "sol-001" }, ctx);
      const res = JSON.parse(raw);

      expect(res.ok).toBe(true);
      expect(res.data.sha256).toBeDefined();
      expect(res.data.sha256).toMatch(/^[a-f0-9]{64}$/i);

      const txtPath = join(WORKSPACE_DIR, "out", "sol-001", "aprobacion.txt");
      const pdfPath = join(WORKSPACE_DIR, "out", "sol-001", "aprobacion.pdf");

      expect(existsSync(txtPath)).toBe(true);
      expect(existsSync(pdfPath)).toBe(true);

      const txtContent = readFileSync(txtPath, "utf-8");
      expect(txtContent).toContain("Mariana López");
      expect(txtContent).toContain(res.data.sha256);

      const pdfBuffer = readFileSync(pdfPath);
      expect(pdfBuffer.subarray(0, 5).toString("utf-8")).toBe("%PDF-");
    });

    it("construir_payload builds valid OrdenCompra with truncated description and writes trazabilidad.json", async () => {
      const pkgRaw = await leer_paquete.execute({ caso: "sol-001" }, ctx);
      const pkg = JSON.parse(pkgRaw).data;

      const valRaw = await validar.execute({ caso: "sol-001", paquete: pkg }, ctx);
      const val = JSON.parse(valRaw).data;

      await generar_evidencia.execute({ caso: "sol-001" }, ctx);

      const raw = await construir_payload.execute(
        { caso: "sol-001", paquete: pkg, derivados: val.derivados },
        ctx
      );
      const res = JSON.parse(raw);

      expect(res.ok).toBe(true);
      const orden = res.data.orden ?? res.data;

      expect(orden.sociedad).toBe("1000");
      expect(orden.organizacion_compras).toBe("1000");
      expect(orden.proveedor.codigo_sap).toBe("100234");
      expect(orden.posiciones.length).toBeGreaterThan(0);
      expect(orden.posiciones[0].numero).toBe(10);
      expect(orden.posiciones[0].descripcion.length).toBeLessThanOrEqual(40);
      expect(orden.aprobador.evidencia_sha256).toMatch(/^[a-f0-9]{64}$/i);

      const trazabilidadPath = join(WORKSPACE_DIR, "out", "sol-001", "trazabilidad.json");
      expect(existsSync(trazabilidadPath)).toBe(true);

      const trazabilidad = JSON.parse(readFileSync(trazabilidadPath, "utf-8"));
      expect(trazabilidad).toBeDefined();
    });
  });

  describe("5. HU-5 (crear & MockSapAdapter & out/control.csv)", () => {
    it("crear assigns 4500000001 to sol-001 and enforces strict idempotency", async () => {
      const pkgRaw = await leer_paquete.execute({ caso: "sol-001" }, ctx);
      const pkg = JSON.parse(pkgRaw).data;
      const valRaw = await validar.execute({ caso: "sol-001", paquete: pkg }, ctx);
      const val = JSON.parse(valRaw).data;
      await generar_evidencia.execute({ caso: "sol-001" }, ctx);
      const bldRaw = await construir_payload.execute(
        { caso: "sol-001", paquete: pkg, derivados: val.derivados },
        ctx
      );
      const payload = JSON.parse(bldRaw).data.orden ?? JSON.parse(bldRaw).data;

      const res1Raw = await crear.execute({ caso: "sol-001", payload }, ctx);
      const res1 = JSON.parse(res1Raw);

      expect(res1.ok).toBe(true);
      expect(res1.data.numero_oc).toBe("4500000001");
      expect(res1.data.idempotente).toBe(false);

      const jsonlPath = join(WORKSPACE_DIR, "out", "sap", "ordenes.jsonl");
      expect(existsSync(jsonlPath)).toBe(true);
      const lines1 = readFileSync(jsonlPath, "utf-8").trim().split("\n");
      expect(lines1.length).toBe(1);

      // Second run: idempotency check
      const res2Raw = await crear.execute({ caso: "sol-001", payload }, ctx);
      const res2 = JSON.parse(res2Raw);

      expect(res2.ok).toBe(true);
      expect(res2.data.numero_oc).toBe("4500000001");
      expect(res2.data.idempotente).toBe(true);

      const lines2 = readFileSync(jsonlPath, "utf-8").trim().split("\n");
      expect(lines2.length).toBe(1);
    });

    it("crear rejects blocked case sol-002, does not write to ordenes.jsonl, and appends to out/control.csv", async () => {
      const pkgRaw = await leer_paquete.execute({ caso: "sol-002" }, ctx);
      const pkg = JSON.parse(pkgRaw).data;
      const valRaw = await validar.execute({ caso: "sol-002", paquete: pkg }, ctx);
      const val = JSON.parse(valRaw).data;

      const bldRaw = await construir_payload.execute(
        { caso: "sol-002", paquete: pkg, derivados: val.derivados },
        ctx
      );
      const payload = JSON.parse(bldRaw).data?.orden ?? JSON.parse(bldRaw).data ?? {
        referencia: { solicitud_id: "SOL-2026-002" },
      };

      const resRaw = await crear.execute({ caso: "sol-002", payload }, ctx);
      const res = JSON.parse(resRaw);

      expect(res.ok).toBe(false);

      const jsonlPath = join(WORKSPACE_DIR, "out", "sap", "ordenes.jsonl");
      if (existsSync(jsonlPath)) {
        const content = readFileSync(jsonlPath, "utf-8");
        expect(content).not.toContain("SOL-2026-002");
      }

      const csvPath = join(WORKSPACE_DIR, "out", "control.csv");
      expect(existsSync(csvPath)).toBe(true);
      const csv = readFileSync(csvPath, "utf-8");
      expect(csv).toContain("SOL-2026-002");
    });

    it("crear requires explicit confirmation for sol-004 before PO creation", async () => {
      const pkgRaw = await leer_paquete.execute({ caso: "sol-004" }, ctx);
      const pkg = JSON.parse(pkgRaw).data;
      const valRaw = await validar.execute({ caso: "sol-004", paquete: pkg }, ctx);
      const val = JSON.parse(valRaw).data;
      await generar_evidencia.execute({ caso: "sol-004" }, ctx);
      const bldRaw = await construir_payload.execute(
        { caso: "sol-004", paquete: pkg, derivados: val.derivados },
        ctx
      );
      const payload = JSON.parse(bldRaw).data.orden ?? JSON.parse(bldRaw).data;

      // First call without confirmation -> pending
      const resPendingRaw = await crear.execute(
        { caso: "sol-004", payload, confirmado: false },
        ctx
      );
      const resPending = JSON.parse(resPendingRaw);
      expect(resPending.ok).toBe(false);

      const csvPending = readFileSync(join(WORKSPACE_DIR, "out", "control.csv"), "utf-8");
      expect(csvPending).toContain("SOL-2026-004");

      // Second call with confirmation -> created
      const resConfirmedRaw = await crear.execute(
        { caso: "sol-004", payload, confirmado: true },
        ctx
      );
      const resConfirmed = JSON.parse(resConfirmedRaw);
      expect(resConfirmed.ok).toBe(true);
      expect(resConfirmed.data.numero_oc).toMatch(/^450000000\d$/);
    });

    it("crear records retroactive flag in out/control.csv for sol-005", async () => {
      const pkgRaw = await leer_paquete.execute({ caso: "sol-005" }, ctx);
      const pkg = JSON.parse(pkgRaw).data;
      const valRaw = await validar.execute({ caso: "sol-005", paquete: pkg }, ctx);
      const val = JSON.parse(valRaw).data;
      await generar_evidencia.execute({ caso: "sol-005" }, ctx);
      const bldRaw = await construir_payload.execute(
        { caso: "sol-005", paquete: pkg, derivados: val.derivados },
        ctx
      );
      const payload = JSON.parse(bldRaw).data.orden ?? JSON.parse(bldRaw).data;

      const resRaw = await crear.execute(
        { caso: "sol-005", payload, confirmado: true },
        ctx
      );
      const res = JSON.parse(resRaw);
      expect(res.ok).toBe(true);

      const csvContent = readFileSync(join(WORKSPACE_DIR, "out", "control.csv"), "utf-8");
      expect(csvContent).toContain("SOL-2026-005");
      expect(csvContent).toMatch(/SOL-2026-005.*true/i);
    });

    it("MockSapAdapter operates correctly against simulated SAP store", async () => {
      const adapter = new MockSapAdapter({ directory: WORKSPACE_DIR });

      const provActivo = await adapter.consultarProveedor("900555111");
      expect(provActivo).toEqual({ codigo_sap: "100234", activo: true });

      const provInactivo = await adapter.consultarProveedor("901777888");
      expect(provInactivo).toEqual({ codigo_sap: "100402", activo: false });

      const provNoExiste = await adapter.consultarProveedor("999999999");
      expect(provNoExiste).toBeNull();

      const notFound = await adapter.buscarOrdenPorReferencia("SOL-MOCK-REF-999");
      expect(notFound).toBeNull();

      const mockOrden: any = {
        referencia: { solicitud_id: "SOL-MOCK-REF-999", correo_id: "m-1", cotizacion_ref: null },
        sociedad: "1000",
        organizacion_compras: "1000",
        proveedor: { codigo_sap: "100234", nit: "900555111", nombre: "TecnoSuministros" },
        moneda: "COP",
        condiciones_pago: "Z030",
        aprobador: { email: "mlopez@test.com", fecha_aprobacion: "2026-08-21", evidencia_sha256: "a".repeat(64) },
        posiciones: [],
        excepciones: [],
      };

      const creada = await adapter.crearOrden(mockOrden);
      expect(creada.numero_oc).toMatch(/^450000000\d$/);

      const encontrada = await adapter.buscarOrdenPorReferencia("SOL-MOCK-REF-999");
      expect(encontrada?.numero_oc).toBe(creada.numero_oc);
    });
  });
});
