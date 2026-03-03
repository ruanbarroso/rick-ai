import OpenAI from "openai";
import { LLMProvider, LLMMessage, LLMResponse, MAIN_LLM_TIMEOUT_MS } from "../types.js";
import { config } from "../../config/env.js";
import { logger } from "../../config/logger.js";

/**
 * Codex Responses API endpoint — used when authenticating via OAuth
 * (user's ChatGPT Pro/Plus subscription).
 */
const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

/**
 * OpenAI provider supporting:
 * 1. Standard API key auth → api.openai.com/v1/chat/completions
 * 2. OAuth (Codex) auth → chatgpt.com/backend-api/codex/responses
 */
export class OpenAIProvider implements LLMProvider {
  name = "openai";
  private apiKeyClient: OpenAI | null = null;

  // OAuth state
  private oauthToken: string | null = null;
  private oauthAccountId: string | null = null;

  private getApiKeyClient(): OpenAI | null {
    if (!config.openai.apiKey) return null;
    if (!this.apiKeyClient) {
      this.apiKeyClient = new OpenAI({ apiKey: config.openai.apiKey });
    }
    return this.apiKeyClient;
  }

  setOAuthToken(token: string | null, accountId?: string | null): void {
    if (!token) {
      this.oauthToken = null;
      this.oauthAccountId = null;
    } else {
      this.oauthToken = token;
      this.oauthAccountId = accountId ?? null;
    }
  }

  isAvailable(): boolean {
    return !!config.openai.apiKey || !!this.oauthToken;
  }

  isOAuthActive(): boolean {
    return !!this.oauthToken;
  }

  async chat(
    messages: LLMMessage[],
    systemPrompt?: string,
    modelOverride?: string,
    signal?: AbortSignal
  ): Promise<LLMResponse> {
    const modelId = modelOverride || config.openai.model;

    // Choose auth mode: OAuth (Codex) takes priority
    if (this.oauthToken) {
      return this.chatWithCodex(messages, systemPrompt, modelId, signal);
    }

    return this.chatWithApiKey(messages, systemPrompt, modelId, signal);
  }

  /**
   * Standard API key mode — Chat Completions API
   */
  private async chatWithApiKey(
    messages: LLMMessage[],
    systemPrompt?: string,
    modelId?: string,
    signal?: AbortSignal
  ): Promise<LLMResponse> {
    const client = this.getApiKeyClient();
    if (!client) throw new Error("OpenAI: no API key available");

    const model = modelId || config.openai.model;

    const openaiMessages: OpenAI.ChatCompletionMessageParam[] = [];
    if (systemPrompt) {
      openaiMessages.push({ role: "system", content: systemPrompt });
    }
    for (const msg of messages) {
      if (msg.role === "system") continue;
      openaiMessages.push({
        role: msg.role as "user" | "assistant",
        content: msg.content,
      });
    }

    const response = await client.chat.completions.create({
      model,
      messages: openaiMessages,
      max_tokens: 4096,
    }, { timeout: MAIN_LLM_TIMEOUT_MS, signal });

    const text = response.choices[0]?.message?.content || "";
    const tokensUsed = response.usage?.total_tokens;

    logger.info({ model, tokensUsed, authMode: "api-key" }, "OpenAI response");

    return {
      content: text,
      model,
      provider: this.name,
      tokensUsed,
    };
  }

  /**
   * OAuth mode — Codex Responses API at chatgpt.com
   * Uses the OpenAI Responses API format (not Chat Completions).
   */
  private async chatWithCodex(
    messages: LLMMessage[],
    systemPrompt?: string,
    modelId?: string,
    signal?: AbortSignal
  ): Promise<LLMResponse> {
    if (!this.oauthToken) throw new Error("OpenAI: no OAuth token available");

    const model = modelId || "gpt-5.3-codex";

    // Build Responses API input format
    // Note: system prompt goes in the top-level `instructions` field (required by Codex API),
    // NOT as a role:"developer" message inside the input array.
    const input: any[] = [];

    for (const msg of messages) {
      if (msg.role === "system") continue;
      if (msg.role === "user") {
        input.push({
          role: "user",
          content: [{ type: "input_text", text: msg.content }],
        });
      } else if (msg.role === "assistant") {
        input.push({
          role: "assistant",
          content: [{ type: "output_text", text: msg.content }],
        });
      }
    }

    const body: Record<string, unknown> = {
      model,
      instructions: systemPrompt || "",
      input,
      store: false,
      stream: false,
    };

    // Build headers
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.oauthToken}`,
      "User-Agent": "rick-ai/1.0",
      originator: "opencode",
    };

    if (this.oauthAccountId) {
      headers["ChatGPT-Account-Id"] = this.oauthAccountId;
    }

    const timeoutSignal = AbortSignal.timeout(MAIN_LLM_TIMEOUT_MS);
    const combinedSignal = signal
      ? AbortSignal.any([timeoutSignal, signal])
      : timeoutSignal;

    const response = await fetch(CODEX_API_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: combinedSignal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error(
        { status: response.status, body: errorBody, model },
        "Codex API error"
      );

      if (response.status === 401 || response.status === 403) {
        throw new Error(`OAUTH_AUTH_FAILED: ${errorBody}`);
      }

      throw new Error(`Codex API error (HTTP ${response.status}): ${errorBody}`);
    }

    const data = await response.json() as any;

    // Parse Responses API output
    let text = "";
    let reasoningText = "";

    if (data.output && Array.isArray(data.output)) {
      for (const item of data.output) {
        if (item.type === "message" && item.content) {
          for (const part of item.content) {
            if (part.type === "output_text") {
              text += part.text;
            }
          }
        }
        if (item.type === "reasoning" && item.summary) {
          for (const s of item.summary) {
            if (s.type === "summary_text") {
              reasoningText += s.text;
            }
          }
        }
      }
    }

    const tokensUsed = data.usage
      ? (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0)
      : undefined;

    logger.info(
      { model, tokensUsed, authMode: "oauth-codex", hasReasoning: !!reasoningText },
      "OpenAI Codex response"
    );

    return {
      content: text || "(resposta vazia)",
      model,
      provider: this.name,
      tokensUsed,
    };
  }
}
