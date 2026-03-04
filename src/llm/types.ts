/** Default timeout for main-session LLM API calls (60 seconds). */
export const MAIN_LLM_TIMEOUT_MS = 60_000;

export interface MediaAttachment {
  data: Buffer;
  mimeType: string;
  /** Original file name (for documents/files sent via WhatsApp or Web UI) */
  fileName?: string;
}

export interface LLMMessage {
  role: "user" | "assistant" | "system";
  content: string;
  media?: MediaAttachment | MediaAttachment[];
}

export interface LLMResponse {
  content: string;
  model: string;
  provider: string;
  tokensUsed?: number;
}

export interface LLMProvider {
  name: string;
  isAvailable(): boolean;
  chat(
    messages: LLMMessage[],
    systemPrompt?: string,
    modelOverride?: string,
    signal?: AbortSignal
  ): Promise<LLMResponse>;
}

export interface ModelConfig {
  id: string;
  alias: string;
  provider: "gemini";
  modelId: string;
}

/**
 * Main session models — Gemini only.
 * Claude and OpenAI are used exclusively in sub-agents
 * (docker/agent.mjs), not in the main session.
 */
export const AVAILABLE_MODELS: ModelConfig[] = [
  {
    id: "gemini-flash",
    alias: "Gemini 3.0 Flash",
    provider: "gemini",
    modelId: "gemini-3-flash-preview",
  },
  {
    id: "gemini-pro",
    alias: "Gemini 3.1 Pro",
    provider: "gemini",
    modelId: "gemini-3.1-pro-preview",
  },
];
