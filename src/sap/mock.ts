import { existsSync, readFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { SapAdapter } from "./adapter";
import type { OrdenCompra, ProveedorMaestro } from "../types/domain";

export class MockSapAdapter implements SapAdapter {
  private directory: string;

  constructor(options?: { directory?: string } | string) {
    if (typeof options === "string") {
      this.directory = options;
    } else if (options && typeof options.directory === "string") {
      this.directory = options.directory;
    } else {
      this.directory = process.cwd();
    }
  }

  private resolveMaestroPath(fileName: string): string | null {
    const candidates = [
      join(this.directory, "fixtures", "maestros", fileName),
      join(this.directory, "fixtures", "reto-03", "maestros", fileName),
    ];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
    return null;
  }

  async consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null> {
    const maestroPath = this.resolveMaestroPath("proveedores.json");
    if (!maestroPath) return null;

    try {
      const content = readFileSync(maestroPath, "utf-8");
      const proveedores = JSON.parse(content) as ProveedorMaestro[];
      const cleanNit = nit.split("-")[0]?.replace(/\D/g, "") ?? "";

      const found = proveedores.find((p) => {
        const pClean = p.nit.split("-")[0]?.replace(/\D/g, "") ?? "";
        return pClean === cleanNit;
      });

      if (!found) return null;
      return {
        codigo_sap: found.codigo_sap,
        activo: Boolean(found.activo),
      };
    } catch {
      return null;
    }
  }

  async buscarOrdenPorReferencia(
    solicitud_id: string
  ): Promise<{ numero_oc: string; fecha?: string } | null> {
    const jsonlPath = join(this.directory, "out", "sap", "ordenes.jsonl");
    if (!existsSync(jsonlPath)) return null;

    try {
      const content = readFileSync(jsonlPath, "utf-8").trim();
      if (!content) return null;
      const lines = content.split("\n");

      for (const line of lines) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line) as {
          numero_oc: string;
          fecha?: string;
          solicitud_id?: string;
          orden?: OrdenCompra;
        };
        if (
          entry.solicitud_id === solicitud_id ||
          entry.orden?.referencia?.solicitud_id === solicitud_id
        ) {
          return {
            numero_oc: entry.numero_oc,
            fecha: entry.fecha,
          };
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  async crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }> {
    const solicitudId = orden.referencia.solicitud_id;
    const existing = await this.buscarOrdenPorReferencia(solicitudId);
    if (existing) {
      return {
        numero_oc: existing.numero_oc,
        fecha: existing.fecha ?? new Date().toISOString(),
      };
    }

    const sapDir = join(this.directory, "out", "sap");
    mkdirSync(sapDir, { recursive: true });

    const jsonlPath = join(sapDir, "ordenes.jsonl");
    let currentCount = 0;
    if (existsSync(jsonlPath)) {
      const content = readFileSync(jsonlPath, "utf-8").trim();
      if (content) {
        currentCount = content.split("\n").filter((l) => l.trim().length > 0).length;
      }
    }

    const numero_oc = String(4500000001 + currentCount);
    const fecha = new Date().toISOString().slice(0, 10);

    const record = {
      numero_oc,
      fecha,
      solicitud_id: solicitudId,
      orden,
    };

    appendFileSync(jsonlPath, JSON.stringify(record) + "\n", "utf-8");

    return { numero_oc, fecha };
  }
}
