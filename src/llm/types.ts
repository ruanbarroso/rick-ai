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
    modelOverride?: string
  ): Promise<LLMResponse>;
}

export interface ModelConfig {
  id: string;
  alias: string;
  provider: "gemini" | "anthropic" | "openai";
  modelId: string;
}

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
  {
    id: "claude-opus",
    alias: "Claude Opus 4.6",
    provider: "anthropic",
    modelId: "claude-opus-4-6",
  },
  {
    id: "gpt-codex",
    alias: "GPT-5.3 Codex",
    provider: "openai",
    modelId: "gpt-5.3-codex",
  },
];
