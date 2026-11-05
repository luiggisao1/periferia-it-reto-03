import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { AgentMessage, ToolDefinition, LlmResponse } from "./adapter";
import {
  AIProvider,
  BaseLLMProvider,
  AdapterChatModel,
  baseMessagesToAgentMessages,
  agentMessagesToBaseMessages,
} from "./base";
import { GeminiProvider, type GeminiProviderOptions } from "./gemini_provider";
import { OpenAIProvider, type OpenAIProviderOptions } from "./openai_provider";
import { AnthropicProvider, type AnthropicProviderOptions } from "./anthropic_provider";
import {
  DeterministicProvider,
  MockProvider,
  HeuristicFallbackLlmAdapter,
} from "./deterministic_provider";
import {
  createProvider,
  createLangChainChatModel,
  createLlmAdapter,
  type ProviderType,
  type ProviderFactoryOptions,
} from "./factory";

export type LangChainModelConfig = ProviderFactoryOptions;

/**
 * Adaptador general que delega al proveedor resuelto por la fábrica (`createProvider`).
 */
export class LangChainLlmAdapter extends AIProvider {
  private readonly delegate: AIProvider;
  readonly name: string;
  readonly model: string;

  constructor(config?: LangChainModelConfig) {
    super();
    this.delegate = createProvider(config);
    this.name = this.delegate.name;
    this.model = this.delegate.model;
  }

  override getChatModel(): BaseChatModel {
    return this.delegate.getChatModel();
  }

  async enviar(mensajes: AgentMessage[], herramientas?: ToolDefinition[]): Promise<LlmResponse> {
    return this.delegate.enviar(mensajes, herramientas);
  }
}

export {
  AIProvider,
  BaseLLMProvider,
  AdapterChatModel,
  baseMessagesToAgentMessages,
  agentMessagesToBaseMessages,
  GeminiProvider,
  type GeminiProviderOptions,
  OpenAIProvider,
  type OpenAIProviderOptions,
  AnthropicProvider,
  type AnthropicProviderOptions,
  DeterministicProvider,
  MockProvider,
  HeuristicFallbackLlmAdapter,
  createProvider,
  createLangChainChatModel,
  createLlmAdapter,
  type ProviderType,
  type ProviderFactoryOptions,
};
