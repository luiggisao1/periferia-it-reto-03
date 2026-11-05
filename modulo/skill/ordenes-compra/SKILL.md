---
name: ordenes-compra
description: Reglas de negocio, validaciones RC1-RC10, trazabilidad y creación de órdenes de compra SAP
---

# Habilidad: Gestión de Órdenes de Compra SAP

Esta habilidad encapsula las políticas de control y procedimientos requeridos para la preparación y creación de órdenes de compra en SAP (sociedad 1000) dentro de Periferia IT Group.

## Reglas de Control Principales (RC1 - RC10)

1. **RC1 (Bloqueo):** Proveedor debe existir en el maestro y encontrarse activo.
2. **RC2 (Bloqueo):** Aprobación debe ser explícita ("Aprobado") y emitida por un líder autorizado para el centro de costos.
3. **RC3 (Bloqueo):** El monto total no debe superar el tope del aprobador en ese centro.
4. **RC4 (Bloqueo):** La subárea debe pertenecer formalmente al centro de costo asignado.
5. **RC5 (Confirmación):** La cotización no debe diferir en más del 2% del valor de la solicitud. Si no se adjunta cotización, requiere confirmación.
6. **RC6 (Confirmación):** Si falta indicador de IVA, derivar del proveedor y solicitar confirmación.
7. **RC7 (Derivado):** Si faltan condiciones de pago, derivar del maestro de proveedores (default Z030).
8. **RC8 (Confirmación):** Si la fecha de factura es anterior a la solicitud, clasificar como retroactiva y pedir confirmación.
9. **RC9 (Confirmación):** Si la fecha de aprobación es anterior a la solicitud, pedir confirmación.
10. **RC10 (Bloqueo):** La cantidad multiplicada por el valor unitario debe igualar el valor total (±1 unidad).

## Especificación Técnica SAP
- Sociedad: 1000
- Organización de Compras: 1000
- Posición inicial: 10
- Longitud máxima de descripción breve: 40 caracteres
- Unidades estándar: UN, H (horas), MES (meses)
- Auditoría: Evidencia documental con resumen canónico y hash SHA-256 en formato TXT y PDF
