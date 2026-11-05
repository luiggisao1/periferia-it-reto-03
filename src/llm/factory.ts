import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIProvider } from "./base";
import { GeminiProvider } from "./gemini_provider";
import { OpenAIProvider } from "./openai_provider";
import { AnthropicProvider } from "./anthropic_provider";
import { DeterministicProvider } from "./deterministic_provider";

export type ProviderType = "gemini" | "google" | "openai" | "anthropic" | "claude" | "deterministic" | "mock" | "auto";

export interface ProviderFactoryOptions {
  provider?: ProviderType | string;
  modelName?: string;
  apiKey?: string;
  temperature?: number;
}

/**
 * Factory del patrón Strategy (inspirado en `interviewer-ai/backend/app/services/factory.py`).
 * Resuelve e instancia el proveedor adecuado (`GeminiProvider`, `OpenAIProvider`,
 * `AnthropicProvider` o `DeterministicProvider`) compartiendo la clase base `AIProvider`.
 */
export function createProvider(options?: ProviderFactoryOptions): AIProvider {
  const rawProvider = (options?.provider || process.env.LLM_PROVIDER || "auto").trim().toLowerCase();

  const googleKey = options?.apiKey || (process.env.GOOGLE_API_KEY || "").trim() || (process.env.GEMINI_API_KEY || "").trim();
  const openaiKey = options?.apiKey || (process.env.OPENAI_API_KEY || "").trim();
  const anthropicKey = options?.apiKey || (process.env.ANTHROPIC_API_KEY || "").trim();

  if (rawProvider === "deterministic" || rawProvider === "mock") {
    return new DeterministicProvider();
  }

  if ((rawProvider === "gemini" || rawProvider === "google") && googleKey) {
    return new GeminiProvider({
      apiKey: googleKey,
      model: options?.modelName,
      temperature: options?.temperature,
    });
  }

  if ((rawProvider === "anthropic" || rawProvider === "claude") && anthropicKey) {
    return new AnthropicProvider({
      apiKey: anthropicKey,
      model: options?.modelName,
      temperature: options?.temperature,
    });
  }

  if (rawProvider === "openai" && openaiKey) {
    return new OpenAIProvider({
      apiKey: openaiKey,
      model: options?.modelName,
      temperature: options?.temperature,
    });
  }

  // Modo "auto": selecciona el proveedor según la clave disponible o cae en DeterministicProvider
  if (rawProvider === "auto" || !rawProvider) {
    if (googleKey) {
      return new GeminiProvider({
        apiKey: googleKey,
        model: options?.modelName,
        temperature: options?.temperature,
      });
    }
    if (anthropicKey) {
      return new AnthropicProvider({
        apiKey: anthropicKey,
        model: options?.modelName,
        temperature: options?.temperature,
      });
    }
    if (openaiKey) {
      return new OpenAIProvider({
        apiKey: openaiKey,
        model: options?.modelName,
        temperature: options?.temperature,
      });
    }
  }

  return new DeterministicProvider();
}

export function createLangChainChatModel(options?: ProviderFactoryOptions): BaseChatModel {
  return createProvider(options).getChatModel();
}

export const createLlmAdapter = createProvider;
