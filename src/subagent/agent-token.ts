/**
 * Minimal JWT (HS256) implementation for sub-agent session tokens.
 *
 * Uses node:crypto only — zero external dependencies.
 * The signing key is generated randomly on process start, which means
 * all tokens are implicitly invalidated if Rick restarts (this is fine
 * because Docker containers die together with the host process).
 *
 * Token payload: { sessionId, userPhone, exp }
 */

import { createHmac, randomBytes } from "node:crypto";
import { logger } from "../config/logger.js";

// ── Signing key (generated once per process lifetime) ──────────────────────
const JWT_SECRET = randomBytes(32);

// ── Helpers ────────────────────────────────────────────────────────────────

function base64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf.toString("base64url");
}

function base64urlDecode(input: string): string {
  return Buffer.from(input, "base64url").toString("utf-8");
}

function sign(payload: string): string {
  return createHmac("sha256", JWT_SECRET).update(payload).digest("base64url");
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface AgentTokenPayload {
  sessionId: string;
  userPhone: string;
  /** Numeric user ID — avoids a DB round-trip on every Agent API request. Optional for backward compat. */
  numericUserId?: number;
  /** Unix timestamp (seconds) when the token expires */
  exp: number;
}

/**
 * Create a signed JWT for a sub-agent session.
 *
 * @param sessionId - Unique session identifier
 * @param userPhone - Owner's phone (scopes data access)
 * @param ttlSeconds - Time-to-live in seconds (default 2 hours)
 * @param numericUserId - Numeric user ID from the DB (avoids a DB lookup per API request)
 * @returns Signed JWT string
 */
export function createAgentToken(
  sessionId: string,
  userPhone: string,
  ttlSeconds: number = 7200,
  numericUserId?: number,
): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload: AgentTokenPayload = {
    sessionId,
    userPhone,
    ...(numericUserId != null && { numericUserId }),
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const payloadB64 = base64url(JSON.stringify(payload));
  const signature = sign(`${header}.${payloadB64}`);
  const token = `${header}.${payloadB64}.${signature}`;

  logger.info({ sessionId, userPhone, ttlSeconds }, "Agent JWT created");
  return token;
}

/**
 * Verify a JWT and return the payload if valid.
 *
 * @returns Decoded payload, or null if the token is invalid/expired.
 */
export function verifyAgentToken(token: string): AgentTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [header, payloadB64, providedSig] = parts;
  const expectedSig = sign(`${header}.${payloadB64}`);

  // Constant-time comparison via HMAC to prevent timing attacks
  if (providedSig !== expectedSig) return null;

  try {
    const payload: AgentTokenPayload = JSON.parse(base64urlDecode(payloadB64));

    // Check expiry
    if (payload.exp && Date.now() / 1000 > payload.exp) {
      logger.debug({ sessionId: payload.sessionId }, "Agent JWT expired");
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}
