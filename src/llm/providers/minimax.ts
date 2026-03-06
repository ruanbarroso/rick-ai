import OpenAI from "openai";
import { LLMProvider, LLMMessage, LLMResponse, MAIN_LLM_TIMEOUT_MS } from "../types.js";
import { config } from "../../config/env.js";
import { logger } from "../../config/logger.js";

export class MiniMaxProvider implements LLMProvider {
  name = "minimax";
  private client: OpenAI;

  constructor() {
    this.client = new OpenAI({
      apiKey: config.minimax.apiKey || "dummy-key-for-free-tier",
      baseURL: config.minimax.baseUrl,
    });
  }

  isAvailable(): boolean {
    return true;
  }

  async chat(
    messages: LLMMessage[],
    systemPrompt?: string,
    modelOverride?: string,
    signal?: AbortSignal
  ): Promise<LLMResponse> {
    const modelId = modelOverride || config.minimax.model;

    const openAIMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

    if (systemPrompt) {
      openAIMessages.push({ role: "system", content: systemPrompt });
    }

    for (const msg of messages) {
      openAIMessages.push({
        role: msg.role,
        content: msg.content,
      });
    }

    const timeoutMs = MAIN_LLM_TIMEOUT_MS;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      if (signal) {
        signal.addEventListener("abort", () => controller.abort());
      }

      const completion = await this.client.chat.completions.create(
        {
          model: modelId,
          messages: openAIMessages,
          temperature: 0.7,
        },
        { signal: controller.signal as AbortSignal }
      );

      clearTimeout(timeoutId);

      const content = completion.choices[0]?.message?.content || "";
      const tokensUsed = completion.usage?.total_tokens;

      logger.info({ model: modelId, tokensUsed }, "MiniMax response");

      return {
        content,
        model: modelId,
        provider: this.name,
        tokensUsed,
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`MiniMax API timeout after ${timeoutMs / 1000}s`);
      }
      throw error;
    }
  }
}
