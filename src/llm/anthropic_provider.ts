import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { AgentMessage, ToolDefinition, LlmResponse } from "./adapter";
import { AIProvider } from "./base";

export interface AnthropicProviderOptions {
  apiKey?: string;
  model?: string;
  temperature?: number;
}

export class AnthropicProvider extends AIProvider {
  readonly name = "anthropic";
  readonly model: string;
  private readonly apiKey: string;
  private readonly temperature: number;

  constructor(options?: AnthropicProviderOptions) {
    super();
    this.apiKey = options?.apiKey || (process.env.ANTHROPIC_API_KEY || "").trim();
    this.model =
      options?.model ||
      (process.env.LLM_MODEL || "").trim() ||
      (process.env.ANTHROPIC_MODEL || "").trim() ||
      "claude-3-5-haiku-latest";
    this.temperature = options?.temperature ?? 0.1;
  }

  override getChatModel(): BaseChatModel {
    return new ChatAnthropic({
      model: this.model,
      apiKey: this.apiKey,
      temperature: this.temperature,
    });
  }

  async enviar(mensajes: AgentMessage[], herramientas?: ToolDefinition[]): Promise<LlmResponse> {
    return this.invokeLangChainModel(this.getChatModel(), mensajes, herramientas);
  }
}
