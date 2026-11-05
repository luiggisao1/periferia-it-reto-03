import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { AgentMessage, ToolDefinition, LlmResponse } from "./adapter";
import { AIProvider } from "./base";

export interface GeminiProviderOptions {
  apiKey?: string;
  model?: string;
  temperature?: number;
}

export class GeminiProvider extends AIProvider {
  readonly name = "gemini";
  readonly model: string;
  private readonly apiKey: string;
  private readonly temperature: number;

  constructor(options?: GeminiProviderOptions) {
    super();
    this.apiKey =
      options?.apiKey ||
      (process.env.GOOGLE_API_KEY || "").trim() ||
      (process.env.GEMINI_API_KEY || "").trim();
    this.model =
      options?.model ||
      (process.env.LLM_MODEL || "").trim() ||
      (process.env.GOOGLE_MODEL || "").trim() ||
      "gemini-2.5-flash";
    this.temperature = options?.temperature ?? 0.1;
  }

  override getChatModel(): BaseChatModel {
    return new ChatGoogleGenerativeAI({
      model: this.model,
      apiKey: this.apiKey,
      temperature: this.temperature,
    });
  }

  async enviar(mensajes: AgentMessage[], herramientas?: ToolDefinition[]): Promise<LlmResponse> {
    return this.invokeLangChainModel(this.getChatModel(), mensajes, herramientas);
  }
}
