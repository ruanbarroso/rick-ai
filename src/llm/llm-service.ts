import { LLMProvider, LLMMessage, LLMResponse, AVAILABLE_MODELS, ModelConfig } from "./types.js";
import { GeminiProvider } from "./providers/gemini.js";
import { MiniMaxProvider } from "./providers/minimax.js";
import { logger } from "../config/logger.js";

function isRateLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return msg.includes("429") || msg.includes("rate limit") || msg.includes("quota") || msg.includes("too many requests");
}

function isAuthError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return msg.includes("401") || msg.includes("403") || msg.includes("api key") || msg.includes("unauthorized");
}

/** MiniMax Free has short-lived rate limits that clear after a few seconds.
 *  Retry up to this many times before giving up. */
const MINIMAX_RATE_LIMIT_MAX_RETRIES = 3;
const MINIMAX_RATE_LIMIT_RETRY_DELAY_MS = 10_000; // 10 seconds

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class LLMService {
  private gemini: GeminiProvider;
  private minimax: MiniMaxProvider;
  private activeModelId: string = "gemini-flash";
  private useFallback: boolean = false;

  constructor() {
    this.gemini = new GeminiProvider();
    this.minimax = new MiniMaxProvider();

    if (!this.gemini.isAvailable()) {
      logger.warn("Gemini not available — using MiniMax as primary provider");
      this.useFallback = true;
      this.activeModelId = "minimax-free";
    }

    logger.info(
      {
        activeModel: this.activeModelId,
        useFallback: this.useFallback,
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

    if (this.useFallback || !this.gemini.isAvailable()) {
      logger.info({ provider: "minimax", model: activeModel.modelId }, "Using MiniMax (primary)");
      return await this.chatMiniMaxWithRetry(messages, systemPrompt, signal);
    }

    try {
      logger.info({ provider: "gemini", model: activeModel.modelId }, "Using Gemini");
      return await this.gemini.chat(messages, systemPrompt, activeModel.modelId, signal);
    } catch (error) {
      const isAuth = isAuthError(error);
      const isRateLimit = isRateLimitError(error);

      logger.warn(
        { error: error instanceof Error ? error.message : String(error), isAuth, isRateLimit },
        "Gemini request failed"
      );

      if (isAuth) {
        logger.warn("Gemini auth error — switching to MiniMax permanently");
        this.useFallback = true;
        this.activeModelId = "minimax-free";
      }

      if (isAuth || isRateLimit) {
        logger.info({ provider: "minimax" }, "Falling back to MiniMax");
        return await this.chatMiniMaxWithRetry(messages, systemPrompt, signal);
      }

      throw error;
    }
  }

  /** Call MiniMax with rate-limit retries. Its free tier has short-lived
   *  rate limits that clear after a few seconds. */
  private async chatMiniMaxWithRetry(
    messages: LLMMessage[],
    systemPrompt?: string,
    signal?: AbortSignal
  ): Promise<LLMResponse> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MINIMAX_RATE_LIMIT_MAX_RETRIES; attempt++) {
      try {
        return await this.minimax.chat(messages, systemPrompt, "minimax-m2.5-free", signal);
      } catch (err) {
        lastError = err;
        if (isRateLimitError(err) && attempt < MINIMAX_RATE_LIMIT_MAX_RETRIES) {
          logger.info(
            { attempt, maxRetries: MINIMAX_RATE_LIMIT_MAX_RETRIES, delayMs: MINIMAX_RATE_LIMIT_RETRY_DELAY_MS },
            `MiniMax rate limit (${attempt}/${MINIMAX_RATE_LIMIT_MAX_RETRIES}), retrying after delay`
          );
          await sleep(MINIMAX_RATE_LIMIT_RETRY_DELAY_MS);
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }
}
