# ADR-001: LangChain Multi-Provider Adapter & Explicit ReAct Loop for SAP Purchase Orders

- **Status:** Accepted
- **Date:** 2026-11-05
- **Context:** Reto Técnico 03 — Agente Conversacional "Órdenes de Compra SAP" (Periferia IT Group)

## Context and Problem Statement
The system must orchestrate an end-to-end conversational agent capable of reading purchase packages, validating 10 internal control rules (RC1–RC10) against SAP master tables, generating SHA-256 PDF/TXT approval evidence, building traceable SAP Purchase Order payloads, and enforcing human-in-the-loop confirmation before creating records in SAP. Crucially, the LLM provider layer must be decoupled behind `enviar(mensajes, herramientas) -> respuesta` (`src/llm/adapter.ts`), while using LangChain in TypeScript to support OpenAI, Google Gemini, and Anthropic transparently.

## Decision Outcome
Chosen option: **Explicit Agent Loop (`src/agent/loop.ts`) paired with `LangChainLlmAdapter` (`src/llm/langchain.ts`) and Zero-Key `HeuristicFallbackLlmAdapter`**.

### Key Architectural Invariants
1. **Strict Separation of Concerns:**
   - **Behavior:** `agent/prompt.md`
   - **Domain Knowledge:** `src/knowledge/ordenes-compra.md`
   - **Deterministic Execution:** `src/tools/oc.ts` (re-exported identically in `modulo/tools/oc.ts`)
2. **Pre-Execution Zod Validation & Non-Throwing Tools:**
   - Every tool argument is validated against its Zod schema prior to execution; failures return `{ ok: false, error }` to the model so it can self-correct without crashing the session.
3. **Defense-in-Depth on Human Confirmation:**
   - Even if a model attempts to call `oc_crear` prematurely on a case with active confirmation rules (RC5, RC6, RC8, RC9), `oc_crear` independently re-evaluates `oc_validar` and blocks creation unless `confirmado === true`.
