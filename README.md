# Reto Técnico 03 — Agente Conversacional "Órdenes de Compra SAP"

> **Proceso de Selección · Equipo Perxia 2.0 · Periferia IT Group**  
> Aplicación conversacional completa e independiente para la automatización, validación de controles y creación de órdenes de compra en SAP S/4HANA.

---

## 1. Características Principales

- **Agente Conversacional ReAct Autónomo:** Interfaz conversacional en tiempo real impulsada por LangChain con soporte multi-proveedor (Google Gemini 2.0 Flash, OpenAI GPT-4o-mini, Anthropic Claude 3.5 Haiku).
- **Herramientas Tipadas Deterministas (`src/tools/oc.ts`):** 
  - `oc_leer_paquete`: Lectura normalizada de correo, solicitud, cotización, aprobación y factura opcional.
  - `oc_validar`: Matriz de 10 reglas de control (RC1 a RC10) clasificando bloqueos terminantes vs. confirmaciones humanas y derivación de maestros.
  - `oc_construir_payload`: Esquema tipado con Zod para SAP S/4HANA con trazabilidad exhaustiva campo a campo a `out/<caso>/trazabilidad.json`.
  - `oc_generar_evidencia`: Generación dual de evidencia en texto plano `aprobacion.txt` (P0) y PDF estructurado `aprobacion.pdf` (P1 con `pdf-lib`) con cálculo determinista de hash SHA-256.
  - `oc_crear`: Adaptador simulado SAP con numeración secuencial correlativa desde `4500000001`, garantía de idempotencia estricta y registro contable en `out/control.csv`.
  - `oc_leer_excel`: Lectura opcional (P1) de libros binarios `.xlsx` mediante la librería `xlsx`.
- **Detección de Órdenes Retroactivas (`sol-005`):** Identificación automática de compras realizadas con factura anterior a la solicitud (RC8), marcándolas en `out/control.csv` para auditoría interna.
- **Frontend Interactivo en React 19:**
  - Historial de chat con renderizado estructurado (tablas, código y estados).
  - **Inspector visible de Tool Calls:** Nombre, duración en milisegundos, estado (`OK`, `BLOQUEO`, `CONFIRMACIÓN`) y drawer expandible con el JSON exacto de entrada y salida.
  - **Banner de Confirmación Humana Prominente (CA3):** Botones directos para confirmar creación de OC con excepciones o rechazar y devolver al solicitante.
  - **Selector de Casos Rápidos:** 1 clic para ejecutar cualquiera de los 6 casos fixture o el prompt de la demo oficial (Sección 11).
  - **Modal de Auditoría SAP y Control:** Visualización interactiva de órdenes generadas (`out/sap/ordenes.jsonl`), log contable (`out/control.csv`) y enlaces directos a las evidencias generadas.
- **Bonus (+10 Pts) — Módulo Reutilizable (`modulo/`):** Agente empaquetado y desacoplado del servidor HTTP para integración en otras plataformas de IA (`modulo/agent.md`, `modulo/tools/oc.ts`, `modulo/skill/ordenes-compra/SKILL.md`).

---

## 2. Requisitos Previos

- **Runtime:** [Bun](https://bun.sh) v1.1+ (Recomendado) o Node.js v20+ con `npm`.
- **API Key (Opcional para chat en vivo):** Al menos una clave de Google Gemini, OpenAI o Anthropic.
  *(Nota: Para ejecutar la verificación de las herramientas con `bun run demo.ts`, **no se requiere ninguna clave de API**).*

---

## 3. Inicio Rápido (Menos de 2 minutos)

### Paso 1: Clonar y configurar variables de entorno
```bash
cp .env.example .env
```
*(Opcional: edita `.env` para agregar tu `GOOGLE_API_KEY`, `OPENAI_API_KEY` o `ANTHROPIC_API_KEY`). Si no configuras claves, el servidor arrancará igualmente y podrás ejecutar la demo determinista y consultar las auditorías.*

### Paso 2: Instalar dependencias
```bash
bun install
```

### Paso 3: Iniciar el servidor de desarrollo
```bash
bun run dev
```
La aplicación estará disponible inmediatamente en:
👉 **[http://localhost:3000](http://localhost:3000)**

---

## 4. Verificación Determinista sin Modelo (`demo.ts`)

Para comprobar la ejecución de todas las herramientas y reglas de control sobre los 6 casos de prueba (`sol-001` a `sol-006`) sin consumir tokens ni requerir claves de API:

```bash
bun run demo.ts
```

Este comando:
1. Limpia y reinicia la carpeta de salidas `out/`.
2. Procesa `sol-001` (Flujo Normal) creando la OC `4500000001` y verifica la **idempotencia** al ejecutarlo una segunda vez.
3. Procesa `sol-002` demostrando el **bloqueo por proveedor inexistente** (RC1).
4. Procesa `sol-003` demostrando el **bloqueo por límite de aprobación excedido** (RC3).
5. Procesa `sol-004` demostrando la **detección de discrepancia >2% en cotización** (RC5) y la confirmación explícita.
6. Procesa `sol-005` demostrando la **detección y registro de orden retroactiva** (`retroactiva = true` en `out/control.csv`).
7. Procesa `sol-006` demostrando la **derivación automática de condiciones de pago e IVA** desde maestros (RC6/RC7).

---

## 5. Ejecución de la Suite de Pruebas (TDD)

```bash
bun test
```
Para verificar tipos de TypeScript:
```bash
bun run typecheck
```

---

## 6. Documentación de la API HTTP

El backend expone una API REST ligera bajo `http://localhost:3000`:

| Método | Endpoint | Descripción | Formato de Entrada / Salida |
|---|---|---|---|
| `GET` | `/api/health` | Estado del servicio y modelo activo (sin exponer credenciales) | Salida: `{ ok: true, provider: string, model: string, maxIterations: 25, maxSessionTokens: 100000 }` |
| `POST` | `/api/chat` | Envía mensaje al agente, procesa el turno ReAct y ejecuta herramientas | Entrada: `{ sessionId?: string, message: string }`<br>Salida: `{ ok: true, sessionId: string, reply: string, toolCalls: ExecutedToolCall[], needsConfirmation: boolean, tokensUsed: number }` |
| `GET` | `/api/sessions/:id` | Consulta el historial completo y llamadas de una sesión | Salida: `{ ok: true, session: SessionData }` |
| `DELETE` | `/api/sessions/:id` | Reinicia y limpia una sesión | Salida: `{ ok: true, message: string }` |
| `GET` | `/api/cases` | Lista los 6 casos fixture con descripciones y entrega los logs vivos de control y órdenes | Salida: `{ ok: true, cases: FixtureCase[], controlLog: string, sapOrders: any[] }` |
| `GET` | `/out/*` | Sirve directamente evidencias generadas (`.pdf`, `.txt`, `.json`, `.csv`) con cabeceras correctas | Archivos de `out/` |

---

## 7. Estructura del Repositorio

```
periferia-it-reto-03/
├── agent/
│   └── prompt.md                        # System Prompt externo del agente
├── src/
│   ├── server.ts                        # Servidor HTTP Bun, API REST y bundling de UI
│   ├── agent/
│   │   └── loop.ts                      # Ciclo ReAct del agente, tope de iteraciones y confirmación
│   ├── llm/
│   │   ├── adapter.ts                   # Interfaz abstracta LlmAdapter
│   │   └── langchain.ts                 # Adaptador LangChain multi-proveedor (Gemini, OpenAI, Anthropic)
│   ├── tools/
│   │   ├── oc.ts                        # Herramientas tipadas Zod (leer, validar, payload, evidencia, crear)
│   │   └── index.ts                     # Registro y despacho de herramientas
│   ├── sap/
│   │   ├── adapter.ts                   # Interfaz SapAdapter oficial (Sección 7.4)
│   │   └── mock.ts                      # Adaptador SAP simulado sobre out/sap/ordenes.jsonl
│   └── knowledge/
│       └── ordenes-compra.md            # Conocimiento del proceso y maestros en Markdown
├── web/
│   ├── index.html                       # HTML base
│   ├── styles.css                       # Sistema de diseño CSS corporativo Periferia IT
│   ├── App.tsx                          # Aplicación React de chat, inspector de herramientas y auditoría
│   └── main.tsx                         # Punto de entrada frontend React 19
├── fixtures/
│   ├── maestros/                        # Maestros SAP (proveedores, centros-costo, iva, pago)
│   └── solicitudes/                     # Casos de prueba sol-001 a sol-006 (solicitud, cotizacion, etc.)
├── modulo/                              # BONUS (+10 Pts): Módulo de agente reutilizable
│   ├── agent.md                         # Prompt y especificación con frontmatter estandarizado
│   ├── tools/oc.ts                      # Herramientas reutilizables desacopladas del servidor
│   └── skill/ordenes-compra/SKILL.md    # Habilidad con directivas de proceso para agentes
├── out/                                 # Salidas generadas en tiempo de ejecución (ignorado en git)
├── demo.ts                              # Script de verificación sin modelo de los 6 casos
├── SOLUCION.md                          # Documento técnico completo (12 secciones obligatorias)
├── README.md                            # Guía de usuario y arquitectura
└── package.json
```

---

## 8. Prompt de la Demo Oficial (Sección 11 del PRD)

En una sesión nueva en el chat web (o haciendo clic en el botón superior **"⚡ Demo Oficial (sol-004)"**):

```
Procesa la solicitud "sol-004". Muéstrame la OC como quedaría en SAP, qué validaciones pasó y cuáles no, y no la crees hasta que yo lo confirme.
```

**Comportamiento del Agente:**
1. Ejecuta `oc_leer_paquete` para `sol-004`.
2. Ejecuta `oc_validar` y detecta que la cotización ($13.200.000 COP) excede en un 10% el monto solicitado ($12.000.000 COP), superando la tolerancia del 2% (RC5).
3. Ejecuta `oc_construir_payload` para proyectar la OC exacta en SAP.
4. Genera la evidencia preliminar con `oc_generar_evidencia`.
5. Muestra las llamadas a herramientas en tarjetas interactivas, presenta el desglose en tabla y activa el **Banner de Confirmación Humana**.
6. **No crea la orden en SAP** hasta que el usuario hace clic en *"✓ Confirmar y Crear OC en SAP"* o escribe *"Confirmo"*. Tras la confirmación, crea la orden correlativa y reporta el número asignado.

---

## 9. Licencia y Créditos

Desarrollado para el **Reto Técnico 03 · Equipo Perxia 2.0 · Periferia IT Group**.  
Todos los derechos reservados.
