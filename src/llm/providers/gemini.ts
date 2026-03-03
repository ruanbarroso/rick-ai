import {
  GoogleGenerativeAI,
  Content,
  Part,
} from "@google/generative-ai";
import { LLMProvider, LLMMessage, LLMResponse, MAIN_LLM_TIMEOUT_MS } from "../types.js";
import { config } from "../../config/env.js";
import { logger } from "../../config/logger.js";

export class GeminiProvider implements LLMProvider {
  name = "gemini";
  private client: GoogleGenerativeAI;

  constructor() {
    this.client = new GoogleGenerativeAI(config.gemini.apiKey);
  }

  isAvailable(): boolean {
    return !!config.gemini.apiKey;
  }

  async chat(
    messages: LLMMessage[],
    systemPrompt?: string,
    modelOverride?: string,
    signal?: AbortSignal
  ): Promise<LLMResponse> {
    const modelId = modelOverride || config.gemini.model;

    const model = this.client.getGenerativeModel({
      model: modelId,
      systemInstruction: systemPrompt || undefined,
    });

    // Build history — Gemini requires first message to be role 'user'
    let history: Content[] = [];
    for (const msg of messages.slice(0, -1)) {
      if (msg.role === "system") continue;
      history.push({
        role: msg.role === "assistant" ? "model" : "user",
        parts: [{ text: msg.content } as Part],
      });
    }
    // Strip leading 'model' messages — Gemini rejects history not starting with 'user'
    while (history.length > 0 && history[0].role === "model") {
      history.shift();
    }

    const lastMessage = messages[messages.length - 1];

    const chat = model.startChat({ history });

    // Build parts for the last message (may include media)
    const lastParts: Part[] = [];
    if (lastMessage.media) {
      const mediaArr = Array.isArray(lastMessage.media) ? lastMessage.media : [lastMessage.media];
      for (const m of mediaArr) {
        lastParts.push({
          inlineData: {
            mimeType: m.mimeType,
            data: m.data.toString("base64"),
          },
        });
      }
    }
    lastParts.push({ text: lastMessage.content });

    // Apply timeout and abort signal to prevent indefinite hangs on API calls
    const resultPromise = chat.sendMessage(lastParts);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Gemini API timeout after ${MAIN_LLM_TIMEOUT_MS / 1000}s`)), MAIN_LLM_TIMEOUT_MS)
    );
    const abortPromise = signal
      ? new Promise<never>((_, reject) => {
          if (signal.aborted) {
            reject(new Error("Gemini API call aborted"));
          }
          signal.addEventListener("abort", () => reject(new Error("Gemini API call aborted")), { once: true });
        })
      : null;
    const racers = abortPromise
      ? [resultPromise, timeoutPromise, abortPromise]
      : [resultPromise, timeoutPromise];
    const result = await Promise.race(racers);
    const response = result.response;
    const text = response.text();

    const tokensUsed = response.usageMetadata?.totalTokenCount || undefined;

    logger.info({ model: modelId, tokensUsed }, "Gemini response");

    return {
      content: text,
      model: modelId,
      provider: this.name,
      tokensUsed,
    };
  }
}
