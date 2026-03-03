import { LLMProvider, LLMMessage, LLMResponse, AVAILABLE_MODELS, ModelConfig } from "./types.js";
import { GeminiProvider } from "./providers/gemini.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { OpenAIProvider } from "./providers/openai.js";
import { logger } from "../config/logger.js";

export class LLMService {
  private providers: Record<string, LLMProvider> = {};
  private activeModelId: string = "gemini-flash";
  private anthropicProvider: AnthropicProvider;
  private openaiProvider: OpenAIProvider;

  constructor() {
    const gemini = new GeminiProvider();
    this.anthropicProvider = new AnthropicProvider();
    this.openaiProvider = new OpenAIProvider();

    if (gemini.isAvailable()) this.providers["gemini"] = gemini;
    // Always register anthropic and openai — they may become available via OAuth
    this.providers["anthropic"] = this.anthropicProvider;
    this.providers["openai"] = this.openaiProvider;

    if (Object.keys(this.providers).length === 0) {
      throw new Error("No LLM provider available. Check your API keys.");
    }

    logger.info(
      {
        activeModel: this.activeModelId,
        availableProviders: Object.keys(this.providers),
        availableModels: this.getAvailableModels().map((m) => m.id),
      },
      "LLM service initialized"
    );
  }

  // ==================== ANTHROPIC OAUTH ====================

  setAnthropicOAuthToken(token: string | null): void {
    this.anthropicProvider.setOAuthToken(token);
    if (token) {
      logger.info("Anthropic OAuth token set — Claude models now available via subscription");
    }
  }

  isAnthropicAvailable(): boolean {
    return this.anthropicProvider.isAvailable();
  }

  isAnthropicOAuth(): boolean {
    return this.anthropicProvider.isOAuthActive();
  }

  // ==================== OPENAI OAUTH ====================

  setOpenAIOAuthToken(token: string | null, accountId?: string | null): void {
    this.openaiProvider.setOAuthToken(token, accountId);
    if (token) {
      logger.info("OpenAI OAuth token set — GPT Codex models now available via subscription");
    }
  }

  isOpenAIAvailable(): boolean {
    return this.openaiProvider.isAvailable();
  }

  isOpenAIOAuth(): boolean {
    return this.openaiProvider.isOAuthActive();
  }

  // ==================== MODEL MANAGEMENT ====================

  switchModel(input: string): ModelConfig | null {
    const lower = input.toLowerCase().trim();

    const model = AVAILABLE_MODELS.find(
      (m) =>
        m.id.toLowerCase() === lower ||
        m.alias.toLowerCase() === lower ||
        m.modelId.toLowerCase() === lower ||
        lower.includes(m.alias.toLowerCase()) ||
        m.alias.toLowerCase().includes(lower) ||
        lower.includes(m.id.toLowerCase())
    );

    if (model && this.providers[model.provider]) {
      // Check if the provider can actually handle requests
      if (model.provider === "anthropic" && !this.anthropicProvider.isAvailable()) {
        return null;
      }
      if (model.provider === "openai" && !this.openaiProvider.isAvailable()) {
        return null;
      }
      this.activeModelId = model.id;
      logger.info({ model: model.id, modelId: model.modelId }, "Switched model");
      return model;
    }

    return null;
  }

  getActiveModel(): ModelConfig {
    return AVAILABLE_MODELS.find((m) => m.id === this.activeModelId) || AVAILABLE_MODELS[0];
  }

  getAvailableModels(): ModelConfig[] {
    return AVAILABLE_MODELS.filter((m) => {
      if (m.provider === "anthropic") return this.anthropicProvider.isAvailable();
      if (m.provider === "openai") return this.openaiProvider.isAvailable();
      const provider = this.providers[m.provider];
      return !!provider;
    });
  }

  /**
   * Chat via the active model — NO fallback.
   * Rick main chat always uses Gemini Flash. Errors propagate to the caller
   * so agent.ts can show them directly to the user.
   *
   * @param signal - Optional AbortSignal to cancel the request.
   */
  async chat(
    messages: LLMMessage[],
    systemPrompt?: string,
    signal?: AbortSignal
  ): Promise<LLMResponse> {
    const activeModel = this.getActiveModel();
    const provider = this.providers[activeModel.provider];

    if (!provider) {
      throw new Error(`Provider "${activeModel.provider}" nao disponivel.`);
    }

    return await provider.chat(messages, systemPrompt, activeModel.modelId, signal);
  }

  /**
   * Chat with a specific provider by name — used for GPT Codex fallback.
   * Bypasses active model selection entirely.
   *
   * @param signal - Optional AbortSignal to cancel the request.
   */
  async chatWithProvider(
    providerName: string,
    messages: LLMMessage[],
    systemPrompt?: string,
    modelId?: string,
    signal?: AbortSignal
  ): Promise<LLMResponse> {
    const provider = this.providers[providerName];
    if (!provider) {
      throw new Error(`Provider "${providerName}" nao disponivel.`);
    }
    const model = modelId || AVAILABLE_MODELS.find((m) => m.provider === providerName)?.modelId;
    return await provider.chat(messages, systemPrompt, model, signal);
  }
}
