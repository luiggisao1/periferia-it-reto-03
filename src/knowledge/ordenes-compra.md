# Base de Conocimiento de Negocio: Proceso de Órdenes de Compra SAP

Este documento consolida las reglas de negocio, tablas maestras y directrices técnicas para la preparación, validación y contabilización de órdenes de compra en SAP (sociedad 1000, organización de compras 1000) en Periferia IT Group.

---

## 1. Matriz de Reglas de Control (RC1 - RC10)

| Regla | Nombre | Tipo | Criterio de Evaluación | Acción de Remediación |
|---|---|---|---|---|
| **RC1** | Existencia y Estado del Proveedor | **Bloqueo** | El proveedor debe existir en el maestro `proveedores.json` (por NIT o por nombre normalizado) y su estado debe ser `activo: true`. | Solicitar creación o reactivación del proveedor en el maestro SAP antes de procesar la OC. |
| **RC2** | Autoridad de Aprobación | **Bloqueo** | El correo de aprobación debe existir, contener la palabra afirmativa "Aprobado" y provenir de un correo listado en los aprobadores del centro de costo de la solicitud. | Solicitar aprobación formal al líder autorizado para el centro de costos. |
| **RC3** | Límite de Gasto (Tope) | **Bloqueo** | El `valor_total` de la solicitud no puede exceder el `tope` asignado al aprobador en el centro de costos respectivo. | Escalar la aprobación a un directivo con límite de gasto suficiente. |
| **RC4** | Consistencia Centro de Costo / Subárea | **Bloqueo** | El centro de costo debe existir y la subárea de la solicitud debe pertenecer a la lista de subáreas autorizadas de dicho centro. | Corregir la subárea o el centro de costos en la solicitud. |
| **RC5** | Tolerancia de Cotización | **Confirmación** | Si no hay cotización, se requiere confirmación. Si existe cotización, la diferencia porcentual absoluta entre el total de la cotización y el total de la solicitud no debe exceder el 2%. | Solicitar confirmación explícita del analista indicando ambos montos antes de crear la OC. |
| **RC6** | Derivación de Indicador de IVA | **Confirmación + Derivado** | Si la solicitud no especifica `indicador_iva`, se deriva del proveedor (`indicador_iva_default` o `C1`) y se pide confirmación humana. | Confirmar si la tasa e indicador derivados aplican para el bien o servicio adquirido. |
| **RC7** | Derivación de Condiciones de Pago | **Derivado** | Si la solicitud no especifica `condiciones_pago`, se deriva automáticamente del maestro de proveedores (`condiciones_pago_default` o `Z030`). Solo se informa. | No requiere confirmación; se registra en la trazabilidad. |
| **RC8** | Detección de Compra Retroactiva | **Confirmación** | Si existe factura adjunta con fecha de emisión anterior a la fecha de la solicitud de compra, la orden se clasifica como `retroactiva = true`. | Solicitar confirmación explícita para compras retroactivas y registrar en log de auditoría. |
| **RC9** | Coherencia Cronológica de Aprobación | **Confirmación** | La fecha del correo de aprobación debe ser igual o posterior a la fecha de la solicitud. | Confirmar si la aprobación corresponde a la versión vigente de la solicitud. |
| **RC10** | Cuadre Aritmético | **Bloqueo** | La multiplicación de `cantidad * valor_unitario` debe ser igual a `valor_total` (tolerancia máxima de ±1 unidad monetaria). | Devolver la solicitud para corregir los cálculos numéricos. |

---

## 2. Maestros de Referencia

### 2.1 Centros de Costo y Aprobadores
- **CC-1010 (Tecnología):** Subáreas: `Infraestructura`, `Soporte`, `Desarrollo`. Aprobadores: Mariana López Cárdenas (`mlopez@periferia-ficticia.com`, tope 50.000.000 COP), Diego García Rincón (`dgarcia@periferia-ficticia.com`, tope 200.000.000 COP).
- **CC-2020 (Administración):** Subáreas: `Compras`, `Servicios Generales`. Aprobador: Rocío Torres Ibáñez (`rtorres@periferia-ficticia.com`, tope 30.000.000 COP).
- **CC-3030 (Comercial):** Subáreas: `Preventa`, `Marketing`. Aprobador: Felipe Vargas Ocampo (`fvargas@periferia-ficticia.com`, tope 80.000.000 COP).

### 2.2 Indicadores de IVA
- `C1`: IVA 19% General (servicios y bienes gravados estándar).
- `C0`: Exento / No gravado (0%).
- `C5`: IVA 5% (bienes con tarifa reducida).

### 2.3 Condiciones de Pago
- `Z000`: Pago inmediato (contado).
- `Z015`: Crédito 15 días.
- `Z030`: Crédito 30 días neto (estándar corporativo).
- `Z060`: Crédito 60 días.

---

## 3. Especificación del Payload de Orden de Compra SAP

- **Sociedad:** `"1000"` fija.
- **Organización de Compras:** `"1000"` fija.
- **Posiciones:** Numeración secuencial de 10 en 10 (`10`, `20`, `30`...).
- **Texto breve de posición (`descripcion`):** Máximo 40 caracteres (límite estricto de SAP GUI / BAPI).
- **Unidad de medida (`unidad`):**
  - `"H"`: Para bolsas de horas, consultoría por horas o servicios técnicos medidos por hora.
  - `"MES"`: Para suscripciones, licencias mensuales o servicios recurrentes (cuando la cantidad representa meses $\le 12$).
  - `"UN"`: Unidades físicas, licencias anuales o cantidades generales.
- **Evidencia criptográfica:** Hash SHA-256 generado sobre el texto canónico del correo de aprobación.
