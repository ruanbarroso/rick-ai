import Anthropic from "@anthropic-ai/sdk";
import { LLMProvider, LLMMessage, LLMResponse, MAIN_LLM_TIMEOUT_MS } from "../types.js";
import { config } from "../../config/env.js";
import { logger } from "../../config/logger.js";

/**
 * Anthropic provider that supports both API key and OAuth token auth.
 * 
 * Priority:
 * 1. OAuth token (from user's Claude Pro/Max subscription) — set dynamically
 * 2. API key (from ANTHROPIC_API_KEY env var) — static fallback
 * 
 * When an OAuth token is set, it uses Authorization: Bearer header.
 * When using API key, it uses X-Api-Key header.
 */
export class AnthropicProvider implements LLMProvider {
  name = "anthropic";
  private apiKeyClient: Anthropic | null = null;
  private oauthClient: Anthropic | null = null;
  private oauthToken: string | null = null;

  private getApiKeyClient(): Anthropic | null {
    if (!config.anthropic.apiKey) return null;
    if (!this.apiKeyClient) {
      this.apiKeyClient = new Anthropic({ apiKey: config.anthropic.apiKey });
    }
    return this.apiKeyClient;
  }

  private getOAuthClient(token: string): Anthropic {
    // Recreate client if token changed
    if (this.oauthToken !== token) {
      this.oauthClient = new Anthropic({
        authToken: token,
        apiKey: null as any, // explicitly skip API key auth
      });
      this.oauthToken = token;
    }
    return this.oauthClient!;
  }

  /**
   * Set an OAuth access token for the next request(s).
   * Call this before chat() to use the user's subscription.
   * Pass null to revert to API key mode.
   */
  setOAuthToken(token: string | null): void {
    if (!token) {
      this.oauthClient = null;
      this.oauthToken = null;
    } else {
      this.oauthToken = token;
      // Client will be created/updated lazily in getOAuthClient
    }
  }

  isAvailable(): boolean {
    return !!config.anthropic.apiKey || !!this.oauthToken;
  }

  /**
   * Check if OAuth is currently active (has a token set).
   */
  isOAuthActive(): boolean {
    return !!this.oauthToken;
  }

  async chat(
    messages: LLMMessage[],
    systemPrompt?: string,
    modelOverride?: string,
    signal?: AbortSignal
  ): Promise<LLMResponse> {
    const modelId = modelOverride || config.anthropic.model;

    const anthropicMessages = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

    // Determine which client to use: OAuth takes priority
    const client = this.oauthToken
      ? this.getOAuthClient(this.oauthToken)
      : this.getApiKeyClient();

    if (!client) {
      throw new Error("Anthropic: no API key or OAuth token available");
    }

    const authMode = this.oauthToken ? "oauth" : "api-key";

    try {
      const response = await client.messages.create({
        model: modelId,
        max_tokens: 4096,
        system: systemPrompt || undefined,
        messages: anthropicMessages,
      }, { timeout: MAIN_LLM_TIMEOUT_MS, signal });

      const text =
        response.content[0].type === "text" ? response.content[0].text : "";
      const tokensUsed =
        response.usage.input_tokens + response.usage.output_tokens;

      logger.info({ model: modelId, tokensUsed, authMode }, "Anthropic response");

      return {
        content: text,
        model: modelId,
        provider: this.name,
        tokensUsed,
      };
    } catch (err: any) {
      // If OAuth fails with auth error, surface it clearly
      if (authMode === "oauth" && (err.status === 401 || err.status === 403)) {
        logger.warn(
          { err: err.message, status: err.status },
          "Anthropic OAuth token rejected"
        );
        throw new Error(`OAUTH_AUTH_FAILED: ${err.message}`);
      }
      throw err;
    }
  }

  /**
   * Chat with a specific OAuth token (for one-off requests).
   * Does not change the persistent token state.
   */
  async chatWithToken(
    token: string,
    messages: LLMMessage[],
    systemPrompt?: string,
    modelOverride?: string,
    signal?: AbortSignal
  ): Promise<LLMResponse> {
    const previousToken = this.oauthToken;
    this.oauthToken = token;
    try {
      return await this.chat(messages, systemPrompt, modelOverride, signal);
    } finally {
      this.oauthToken = previousToken;
    }
  }
}
