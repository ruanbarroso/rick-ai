import { createHash, randomBytes } from "node:crypto";
import { query } from "../memory/db.js";
import { logger } from "../config/logger.js";

// ==================== CONSTANTS ====================
// Same values used by OpenAI Codex CLI / opencode

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";
const AUTH_URL = `${ISSUER}/oauth/authorize`;
const TOKEN_URL = `${ISSUER}/oauth/token`;

// We use localhost as redirect — the browser will fail to connect,
// but the URL bar will contain the code. User copies the URL back.
const OAUTH_PORT = 1455;
const REDIRECT_URI = `http://localhost:${OAUTH_PORT}/auth/callback`;

const SCOPES = "openid profile email offline_access";

/** Buffer before expiry to trigger proactive refresh (5 minutes) */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

// ==================== TYPES ====================

export interface OpenAIOAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId: string | null;
  accountEmail: string | null;
}

interface PendingAuth {
  codeVerifier: string;
  state: string;
  createdAt: number;
}

interface TokenResponse {
  id_token?: string;
  access_token: string;
  refresh_token: string;
  expires_in?: number;
}

// ==================== PKCE HELPERS ====================

function base64url(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function generatePKCE(): { codeVerifier: string; codeChallenge: string; state: string } {
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(
    createHash("sha256").update(codeVerifier).digest()
  );
  const state = randomBytes(32).toString("hex");
  return { codeVerifier, codeChallenge, state };
}

// ==================== JWT HELPERS ====================

function decodeJwtPayload(token: string): Record<string, any> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], "base64url").toString("utf-8");
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function extractAccountId(tokens: TokenResponse): string | undefined {
  for (const tokenStr of [tokens.id_token, tokens.access_token]) {
    if (!tokenStr) continue;
    const claims = decodeJwtPayload(tokenStr);
    if (!claims) continue;
    if (claims.chatgpt_account_id) return claims.chatgpt_account_id;
    const auth = claims["https://api.openai.com/auth"];
    if (auth?.chatgpt_account_id) return auth.chatgpt_account_id;
    if (claims.organizations?.[0]?.id) return claims.organizations[0].id;
  }
  return undefined;
}

function extractEmail(tokens: TokenResponse): string | undefined {
  for (const tokenStr of [tokens.id_token, tokens.access_token]) {
    if (!tokenStr) continue;
    const claims = decodeJwtPayload(tokenStr);
    if (!claims) continue;
    if (claims.email) return claims.email;
  }
  return undefined;
}

// ==================== OPENAI OAUTH SERVICE ====================

export class OpenAIOAuthService {
  private pendingAuths = new Map<string, PendingAuth>();
  /** Shared in-memory token cache keyed by userId. */
  private tokenCache = new Map<number, OpenAIOAuthTokens>();
  /** Deduplicate concurrent refresh attempts in-process. */
  private refreshInProgress = new Map<number, Promise<{ accessToken: string; accountId: string | null } | null>>();

  constructor() {
    // Clean up expired pending auths every 5 minutes
    setInterval(() => {
      const now = Date.now();
      for (const [state, auth] of this.pendingAuths) {
        if (now - auth.createdAt > 10 * 60 * 1000) {
          this.pendingAuths.delete(state);
        }
      }
    }, 5 * 60 * 1000);
  }

  /**
   * Step 1: Generate the authorization URL.
   * User opens this in their browser, authorizes, gets redirected to localhost
   * (which fails), then copies the URL from the address bar.
   */
  startAuth(): { authUrl: string; state: string } {
    const { codeVerifier, codeChallenge, state } = generatePKCE();

    this.pendingAuths.set(state, {
      codeVerifier,
      state,
      createdAt: Date.now(),
    });

    const params = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: "rick-ai",
    });

    const authUrl = `${AUTH_URL}?${params.toString()}`;

    logger.info({ state }, "OpenAI OAuth: auth flow started");
    return { authUrl, state };
  }

  /**
   * Step 2: Exchange the callback URL or code for tokens.
   * The user pastes either:
   * - The full callback URL: http://localhost:1455/auth/callback?code=XXX&state=YYY
   * - Just the code parameter value
   */
  async exchangeCallback(
    userId: number,
    rawInput: string
  ): Promise<{ success: boolean; error?: string; email?: string }> {
    let code: string | null = null;
    let state: string | null = null;

    const trimmed = rawInput.trim();

    // Try to parse as URL (full callback URL pasted)
    if (trimmed.startsWith("http")) {
      try {
        const url = new URL(trimmed);
        code = url.searchParams.get("code");
        state = url.searchParams.get("state");

        // Check for OAuth error in callback
        const error = url.searchParams.get("error");
        if (error) {
          const errorDesc = url.searchParams.get("error_description") || error;
          return { success: false, error: `OpenAI retornou erro: ${errorDesc}` };
        }
      } catch {
        // Not a valid URL
      }
    }

    if (!code) {
      return {
        success: false,
        error: "Nao consegui extrair o codigo da URL. Cole a URL completa da barra de enderecos.",
      };
    }

    // Find matching pending auth by state
    let pending: PendingAuth | undefined;
    if (state) {
      pending = this.pendingAuths.get(state);
    }
    if (!pending && this.pendingAuths.size === 1) {
      // Only one pending, assume it's the right one
      const [, singlePending] = [...this.pendingAuths.entries()][0];
      pending = singlePending;
    }

    if (!pending) {
      return {
        success: false,
        error: "Sessao de autenticacao expirou. Gere um novo link pelas configuracoes.",
      };
    }

    // Exchange code for tokens
    try {
      const response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT_URI,
          client_id: CLIENT_ID,
          code_verifier: pending.codeVerifier,
        }).toString(),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        logger.error(
          { status: response.status, body: errorBody },
          "OpenAI OAuth: token exchange failed"
        );
        return {
          success: false,
          error: `Erro na troca de tokens (HTTP ${response.status}). Tente novamente pelas configuracoes.`,
        };
      }

      const tokens = (await response.json()) as TokenResponse;
      const accountId = extractAccountId(tokens) || null;
      const email = extractEmail(tokens) || null;

      await this.saveTokens(userId, tokens, accountId, email);
      this.tokenCache.set(userId, {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
        accountId,
        accountEmail: email,
      });

      // Clean up pending auth
      this.pendingAuths.delete(pending.state);

      logger.info(
        { userId, email, accountId },
        "OpenAI OAuth: connected successfully"
      );

      return { success: true, email: email || undefined };
    } catch (err) {
      logger.error({ err }, "OpenAI OAuth: exchange error");
      return { success: false, error: "Erro ao trocar codigo por tokens. Tente novamente." };
    }
  }

  /**
   * Get a valid access token. Auto-refreshes if expired.
   */
  async getValidToken(userId: number): Promise<{ accessToken: string; accountId: string | null } | null> {
    const cached = this.tokenCache.get(userId);
    if (cached && cached.expiresAt > Date.now() + EXPIRY_BUFFER_MS) {
      return { accessToken: cached.accessToken, accountId: cached.accountId };
    }

    const stored = await this.loadTokens(userId);
    if (!stored) return null;

    if (stored.expiresAt > Date.now() + EXPIRY_BUFFER_MS) {
      this.tokenCache.set(userId, stored);
      return { accessToken: stored.accessToken, accountId: stored.accountId };
    }

    if (!stored.refreshToken) {
      await this.disconnect(userId);
      return null;
    }

    const existing = this.refreshInProgress.get(userId);
    if (existing) return existing;

    const refreshPromise = this.doRefresh(userId, stored.refreshToken);
    this.refreshInProgress.set(userId, refreshPromise);
    try {
      return await refreshPromise;
    } finally {
      this.refreshInProgress.delete(userId);
    }
  }

  async isConnected(userId: number): Promise<{ connected: boolean; email?: string }> {
    const stored = await this.loadTokens(userId);
    if (!stored) return { connected: false };

    const isExpired = stored.expiresAt <= Date.now();
    const hasRefresh = !!stored.refreshToken;

    return {
      connected: !isExpired || hasRefresh,
      email: stored.accountEmail || undefined,
    };
  }

  async disconnect(userId: number): Promise<void> {
    this.tokenCache.delete(userId);
    await query(
      `DELETE FROM oauth_tokens WHERE user_id = $1 AND provider = 'openai'`,
      [userId]
    );
    logger.info({ userId }, "OpenAI OAuth: disconnected");
  }

  hasPendingAuth(): boolean {
    return this.pendingAuths.size > 0;
  }

  // ==================== PRIVATE ====================

  private async refreshTokens(refreshToken: string): Promise<TokenResponse> {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }).toString(),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Refresh failed (HTTP ${response.status}): ${body}`);
    }

    return (await response.json()) as TokenResponse;
  }

  private async saveTokens(
    userId: number,
    tokens: TokenResponse,
    accountId: string | null,
    email: string | null
  ): Promise<void> {
    await this.saveTokensWithQuery(query, userId, tokens, accountId, email);
  }

  private async saveTokensWithQuery(
    q: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number }>,
    userId: number,
    tokens: TokenResponse,
    accountId: string | null,
    email: string | null
  ): Promise<void> {
    const expiresAt = Date.now() + (tokens.expires_in || 3600) * 1000;

    await q(
      `INSERT INTO oauth_tokens (user_id, provider, access_token, refresh_token, expires_at, scopes, account_email, org_name, is_active, updated_at)
       VALUES ($1, 'openai', $2, $3, $4, $5, $6, $7, TRUE, NOW())
       ON CONFLICT (user_id, provider)
       DO UPDATE SET
         access_token = excluded.access_token,
         refresh_token = excluded.refresh_token,
         expires_at = excluded.expires_at,
         scopes = excluded.scopes,
         account_email = COALESCE(excluded.account_email, oauth_tokens.account_email),
         org_name = COALESCE(excluded.org_name, oauth_tokens.org_name),
         is_active = TRUE,
         updated_at = NOW()`,
      [
        userId,
        tokens.access_token,
        tokens.refresh_token,
        expiresAt,
        JSON.stringify(["openid", "profile", "email", "offline_access"]),
        email,
        accountId,
      ]
    );
  }

  private async doRefresh(
    userId: number,
    refreshToken: string
  ): Promise<{ accessToken: string; accountId: string | null } | null> {
    try {
      const refreshed = await this.refreshTokens(refreshToken);
      const current = await this.loadTokens(userId);
      const accountId = extractAccountId(refreshed) || current?.accountId || null;
      const email = extractEmail(refreshed) || current?.accountEmail || null;
      await this.saveTokens(userId, refreshed, accountId, email);

      const newTokens: OpenAIOAuthTokens = {
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token,
        expiresAt: Date.now() + (refreshed.expires_in || 3600) * 1000,
        accountId,
        accountEmail: email,
      };
      this.tokenCache.set(userId, newTokens);

      logger.info({ userId }, "OpenAI OAuth: token refreshed (deduped in-process)");
      return { accessToken: refreshed.access_token, accountId };
    } catch (err) {
      logger.error({ err, userId }, "OpenAI OAuth: refresh failed");
      this.tokenCache.delete(userId);
      await this.markDisconnected(userId);
      return null;
    }
  }

  private async loadTokens(userId: number): Promise<OpenAIOAuthTokens | null> {
    const result = await query(
      `SELECT access_token, refresh_token, expires_at, account_email, org_name
       FROM oauth_tokens 
       WHERE user_id = $1 AND provider = 'openai' AND is_active = TRUE`,
      [userId]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      expiresAt: Number(row.expires_at),
      accountId: row.org_name,
      accountEmail: row.account_email,
    };
  }

  private async markDisconnected(userId: number): Promise<void> {
    this.tokenCache.delete(userId);
    await query(
      `UPDATE oauth_tokens SET is_active = FALSE, updated_at = NOW()
       WHERE user_id = $1 AND provider = 'openai'`,
      [userId]
    );
  }
}
