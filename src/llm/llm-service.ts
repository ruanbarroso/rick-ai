import { LLMMessage, LLMResponse, AVAILABLE_MODELS, ModelConfig } from "./types.js";
import { GeminiProvider } from "./providers/gemini.js";
import { logger } from "../config/logger.js";

export class LLMService {
  private gemini: GeminiProvider;
  private activeModelId: string = "gemini-flash";

  constructor() {
    this.gemini = new GeminiProvider();

    logger.info(
      {
        activeModel: this.activeModelId,
        availableModels: AVAILABLE_MODELS.map((m) => m.id),
      },
      "LLM service initialized"
    );
  }

  getActiveModel(): ModelConfig {
    return AVAILABLE_MODELS.find((m) => m.id === this.activeModelId) || AVAILABLE_MODELS[0];
  }

  getAvailableModels(): ModelConfig[] {
    return AVAILABLE_MODELS;
  }

  async chat(
    messages: LLMMessage[],
    systemPrompt?: string,
    signal?: AbortSignal
  ): Promise<LLMResponse> {
    const activeModel = this.getActiveModel();
    logger.info({ provider: "gemini", model: activeModel.modelId }, "Using Gemini");
    return await this.gemini.chat(messages, systemPrompt, activeModel.modelId, signal);
  }
}
