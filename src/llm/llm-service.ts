import { LLMProvider, LLMMessage, LLMResponse, AVAILABLE_MODELS, ModelConfig } from "./types.js";
import { GeminiProvider } from "./providers/gemini.js";
import { logger } from "../config/logger.js";

/**
 * Main-session LLM service — Gemini only.
 *
 * Claude and OpenAI are used exclusively in sub-agents
 * (docker/agent.mjs). The main session always uses
 * Gemini Flash for direct chat.
 */
export class LLMService {
  private gemini: GeminiProvider;
  private activeModelId: string = "gemini-flash";

  constructor() {
    this.gemini = new GeminiProvider();

    if (!this.gemini.isAvailable()) {
      throw new Error("Gemini provider not available. Check GEMINI_API_KEY.");
    }

    logger.info(
      {
        activeModel: this.activeModelId,
        availableModels: AVAILABLE_MODELS.map((m) => m.id),
      },
      "LLM service initialized (Gemini only)"
    );
  }

  // ==================== MODEL MANAGEMENT ====================

  getActiveModel(): ModelConfig {
    return AVAILABLE_MODELS.find((m) => m.id === this.activeModelId) || AVAILABLE_MODELS[0];
  }

  getAvailableModels(): ModelConfig[] {
    return AVAILABLE_MODELS;
  }

  /**
   * Chat via the active model — NO fallback.
   * Main session always uses Gemini. Errors propagate to the caller
   * so agent.ts can show them directly to the user.
   */
  async chat(
    messages: LLMMessage[],
    systemPrompt?: string,
    signal?: AbortSignal
  ): Promise<LLMResponse> {
    const activeModel = this.getActiveModel();
    return await this.gemini.chat(messages, systemPrompt, activeModel.modelId, signal);
  }
}
