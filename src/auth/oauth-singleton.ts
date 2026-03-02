import { ClaudeOAuthService } from "./claude-oauth.js";
import { OpenAIOAuthService } from "./openai-oauth.js";

/**
 * Shared OAuth services for this process.
 *
 * Keeps one in-memory cache/dedup state per provider, reused by Agent,
 * WebConnector and any other component in the same runtime.
 */
export const claudeOAuthService = new ClaudeOAuthService();
export const openaiOAuthService = new OpenAIOAuthService();
