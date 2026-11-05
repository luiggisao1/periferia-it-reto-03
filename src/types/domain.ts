import { z } from "zod";

export const SolicitudSchema = z.object({
  solicitud_id: z.string(),
  solicitante: z.string(),
  proveedor_nombre: z.string(),
  proveedor_nit: z.string().optional(),
  descripcion: z.string(),
  centro_costo: z.string(),
  subarea: z.string(),
  cantidad: z.number(),
  valor_unitario: z.number(),
  valor_total: z.number(),
  moneda: z.enum(["COP", "USD"]),
  indicador_iva: z.string().optional(),
  condiciones_pago: z.string().optional(),
  fecha_solicitud: z.string(),
});
export type Solicitud = z.infer<typeof SolicitudSchema>;

export const CorreoSchema = z.object({
  id: z.string(),
  de: z.string(),
  asunto: z.string(),
  fecha: z.string(),
  para: z.string().optional(),
  cuerpo: z.string().optional(),
  adjuntos: z.array(z.string()).optional(),
});
export type Correo = z.infer<typeof CorreoSchema>;

export const CotizacionNormalizadaSchema = z.object({
  proveedor: z.string(),
  nit: z.string().nullable(),
  total: z.number(),
  moneda: z.string(),
  validez_hasta: z.string().nullable(),
  texto: z.string(),
});
export type CotizacionNormalizada = z.infer<typeof CotizacionNormalizadaSchema>;

export const AprobacionNormalizadaSchema = z.object({
  de: z.string(),
  fecha: z.string(),
  aprobado: z.boolean(),
  texto: z.string(),
  para: z.string().optional(),
  asunto: z.string().optional(),
});
export type AprobacionNormalizada = z.infer<typeof AprobacionNormalizadaSchema>;

export const FacturaNormalizadaSchema = z.object({
  numero: z.string(),
  fecha: z.string(),
  total: z.number(),
});
export type FacturaNormalizada = z.infer<typeof FacturaNormalizadaSchema>;

export const PaqueteSchema = z.object({
  correo: CorreoSchema,
  solicitud: SolicitudSchema,
  cotizacion: CotizacionNormalizadaSchema.nullable(),
  aprobacion: AprobacionNormalizadaSchema.nullable(),
  factura: FacturaNormalizadaSchema.nullable(),
  adjuntos_faltantes: z.array(z.string()).optional(),
});
export type Paquete = z.infer<typeof PaqueteSchema>;

export const HallazgoReglaSchema = z.object({
  regla: z.string(),
  codigo: z.string(),
  detalle: z.string(),
  accion_sugerida: z.string().optional(),
});
export type HallazgoRegla = z.infer<typeof HallazgoReglaSchema>;

export const DerivadosSchema = z.object({
  codigo_sap: z.string().optional(),
  proveedor_nit: z.string().optional(),
  proveedor_nombre: z.string().optional(),
  indicador_iva: z.string().optional(),
  condiciones_pago: z.string().optional(),
});
export type Derivados = z.infer<typeof DerivadosSchema>;

export const ValidacionResultadoSchema = z.object({
  apta: z.boolean(),
  bloqueos: z.array(HallazgoReglaSchema),
  confirmaciones: z.array(HallazgoReglaSchema),
  derivados: DerivadosSchema,
  retroactiva: z.boolean(),
});
export type ValidacionResultado = z.infer<typeof ValidacionResultadoSchema>;

export const PosicionOrdenCompraSchema = z.object({
  numero: z.number(),
  descripcion: z.string().max(40),
  cantidad: z.number(),
  unidad: z.enum(["UN", "H", "MES"]),
  precio_unitario: z.number(),
  centro_costo: z.string(),
  subarea: z.string(),
  indicador_iva: z.string(),
});
export type PosicionOrdenCompra = z.infer<typeof PosicionOrdenCompraSchema>;

export const ExcepcionOrdenCompraSchema = z.object({
  codigo: z.string(),
  detalle: z.string(),
  confirmado_por: z.string().nullable(),
});
export type ExcepcionOrdenCompra = z.infer<typeof ExcepcionOrdenCompraSchema>;

export const OrdenCompraSchema = z.object({
  referencia: z.object({
    solicitud_id: z.string(),
    correo_id: z.string(),
    cotizacion_ref: z.string().nullable(),
  }),
  sociedad: z.literal("1000"),
  organizacion_compras: z.literal("1000"),
  proveedor: z.object({
    codigo_sap: z.string(),
    nit: z.string(),
    nombre: z.string(),
  }),
  moneda: z.enum(["COP", "USD"]),
  condiciones_pago: z.string(),
  aprobador: z.object({
    email: z.string(),
    fecha_aprobacion: z.string(),
    evidencia_sha256: z.string(),
  }),
  posiciones: z.array(PosicionOrdenCompraSchema),
  excepciones: z.array(ExcepcionOrdenCompraSchema),
});
export type OrdenCompra = z.infer<typeof OrdenCompraSchema>;

export interface ProveedorMaestro {
  codigo_sap: string;
  nit: string;
  nombre: string;
  condiciones_pago_default: string;
  indicador_iva_default: string;
  activo: boolean;
}

export interface CentroCostoMaestro {
  centro_costo: string;
  nombre: string;
  subareas: string[];
  aprobadores: Array<{
    email: string;
    nombre: string;
    tope: number;
  }>;
}

export interface IndicadorIvaMaestro {
  codigo: string;
  descripcion: string;
  tasa: number;
}

export interface CondicionPagoMaestro {
  codigo: string;
  descripcion: string;
  dias: number;
}
