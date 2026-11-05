import { ChatOpenAI } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { AgentMessage, ToolDefinition, LlmResponse } from "./adapter";
import { AIProvider } from "./base";

export interface OpenAIProviderOptions {
  apiKey?: string;
  model?: string;
  temperature?: number;
}

export class OpenAIProvider extends AIProvider {
  readonly name = "openai";
  readonly model: string;
  private readonly apiKey: string;
  private readonly temperature: number;

  constructor(options?: OpenAIProviderOptions) {
    super();
    this.apiKey = options?.apiKey || (process.env.OPENAI_API_KEY || "").trim();
    this.model =
      options?.model ||
      (process.env.LLM_MODEL || "").trim() ||
      (process.env.OPENAI_MODEL || "").trim() ||
      "gpt-4o-mini";
    this.temperature = options?.temperature ?? 0.1;
  }

  override getChatModel(): BaseChatModel {
    return new ChatOpenAI({
      model: this.model,
      apiKey: this.apiKey,
      temperature: this.temperature,
    });
  }

  async enviar(mensajes: AgentMessage[], herramientas?: ToolDefinition[]): Promise<LlmResponse> {
    return this.invokeLangChainModel(this.getChatModel(), mensajes, herramientas);
  }
}
