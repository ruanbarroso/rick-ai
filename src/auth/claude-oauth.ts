import { createHash, randomBytes } from "node:crypto";
import { query } from "../memory/db.js";
import { logger } from "../config/logger.js";

// ==================== CONSTANTS ====================
// These are the same values Claude Code CLI uses.
// Not publicly documented — extracted from the CLI itself.

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTH_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";

const SCOPES = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
].join(" ");

const TOKEN_EXCHANGE_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  Accept: "application/json",
  Referer: "https://claude.ai/",
  Origin: "https://claude.ai",
};

/** Buffer before expiry to trigger proactive refresh (5 minutes) */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

// ==================== TYPES ====================

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // ms timestamp
  scopes: string[];
  accountEmail: string | null;
  orgName: string | null;
}

interface PendingAuth {
  codeVerifier: string;
  state: string;
  createdAt: number;
}

interface TokenResponse {
  token_type: string;
  access_token: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
  organization?: { uuid: string; name: string };
  account?: { uuid: string; email_address: string };
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

// ==================== CLAUDE OAUTH SERVICE ====================

export class ClaudeOAuthService {
  /**
   * In-memory storage for pending auth flows.
   * Keyed by state. Expires after 10 minutes.
   */
  private pendingAuths = new Map<string, PendingAuth>();

  /**
   * In-memory token cache keyed by userId.
   * Avoids hitting DB and refresh endpoint on every getValidToken() call.
   * All callers (edit sessions, sub-agents, etc.) share this cache.
   */
  private tokenCache = new Map<number, OAuthTokens>();

  /**
   * Prevents concurrent refresh attempts for the same user.
   * If a refresh is in progress, subsequent calls wait for it instead of starting a new one.
   */
  private refreshInProgress = new Map<number, Promise<string | null>>();

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
   * Step 1: Generate the authorization URL for the user.
   * Returns the URL that the user must open in their browser.
   */
  startAuth(): { authUrl: string; state: string } {
    const { codeVerifier, codeChallenge, state } = generatePKCE();

    // Store PKCE verifier for later exchange
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
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      code: "true", // Shows the code on screen for user to copy
    });

    const authUrl = `${AUTH_URL}?${params.toString()}`;

    logger.info({ state }, "Claude OAuth: auth flow started");
    return { authUrl, state };
  }

  /**
   * Step 2: Exchange the authorization code for tokens.
   * The user pastes a code in format "code#state" from claude.ai.
   */
  async exchangeCode(
    userId: number,
    rawCode: string
  ): Promise<{ success: boolean; error?: string; email?: string }> {
    // Parse code — Anthropic returns "code#state"
    let code = rawCode.trim();
    let state: string | undefined;

    if (code.includes("#")) {
      const parts = code.split("#");
      code = parts[0];
      state = parts[1];
    }

    if (!state) {
      // Try to match against any pending auth
      if (this.pendingAuths.size === 1) {
        const [pendingState] = this.pendingAuths.keys();
        state = pendingState;
      } else {
        return {
          success: false,
          error: "Codigo invalido. O formato deve ser 'codigo#state'. Tente novamente pelas configuracoes.",
        };
      }
    }

    const pending = this.pendingAuths.get(state);
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
        headers: TOKEN_EXCHANGE_HEADERS,
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: CLIENT_ID,
          code,
          code_verifier: pending.codeVerifier,
          redirect_uri: REDIRECT_URI,
          state,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        logger.error(
          { status: response.status, body: errorBody },
          "Claude OAuth: token exchange failed"
        );
        return {
          success: false,
          error: `Erro na troca de tokens (HTTP ${response.status}). Tente novamente pelas configuracoes.`,
        };
      }

      const tokens = (await response.json()) as TokenResponse;

      // Save tokens to DB
      await this.saveTokens(userId, tokens);

      // Update in-memory cache
      this.tokenCache.set(userId, {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: Date.now() + tokens.expires_in * 1000,
        scopes: tokens.scope.split(" "),
        accountEmail: tokens.account?.email_address || null,
        orgName: tokens.organization?.name || null,
      });

      // Clean up pending auth
      this.pendingAuths.delete(state);

      const email = tokens.account?.email_address || null;
      logger.info(
        { userId, email, org: tokens.organization?.name },
        "Claude OAuth: connected successfully"
      );

      return { success: true, email: email || undefined };
    } catch (err) {
      logger.error({ err }, "Claude OAuth: exchange error");
      return {
        success: false,
        error: "Erro ao trocar o codigo por tokens. Tente novamente.",
      };
    }
  }

  /**
   * Get a valid access token for the user.
   * Uses in-memory cache to avoid redundant DB hits and refresh calls.
   * Deduplicates concurrent refresh attempts.
   * Returns null if user is not connected.
   */
  async getValidToken(userId: number, forceRefresh = false): Promise<string | null> {
    // 1. Check in-memory cache first (skip when force-refreshing, e.g. after 401)
    if (!forceRefresh) {
      const cached = this.tokenCache.get(userId);
      if (cached && cached.expiresAt > Date.now() + EXPIRY_BUFFER_MS) {
        return cached.accessToken;
      }
    } else {
      this.tokenCache.delete(userId);
    }

    // 2. Cache miss or expired — load from DB
    const stored = await this.loadTokens(userId);
    if (!stored) {
      this.tokenCache.delete(userId);
      return null;
    }

    // 3. Token still valid? Update cache and return (skip when force-refreshing)
    if (!forceRefresh && stored.expiresAt > Date.now() + EXPIRY_BUFFER_MS) {
      this.tokenCache.set(userId, stored);
      return stored.accessToken;
    }

    // 4. Token expired (or force refresh) — need refresh. Deduplicate concurrent refreshes.
    if (!stored.refreshToken) {
      logger.warn({ userId }, "Claude OAuth: no refresh token, disconnecting");
      this.tokenCache.delete(userId);
      await this.disconnect(userId);
      return null;
    }

    // If a refresh is already in progress for this user, wait for it
    const existing = this.refreshInProgress.get(userId);
    if (existing) {
      return existing;
    }

    // Start the refresh and store the promise so others can wait on it
    const refreshPromise = this.doRefresh(userId, stored.refreshToken);
    this.refreshInProgress.set(userId, refreshPromise);

    try {
      return await refreshPromise;
    } finally {
      this.refreshInProgress.delete(userId);
    }
  }

  /**
   * Actually perform the token refresh. Separated to allow deduplication.
   */
  private async doRefresh(userId: number, refreshToken: string): Promise<string | null> {
    try {
      const refreshed = await this.refreshTokens(refreshToken);
      await this.saveTokens(userId, refreshed);

      const newTokens: OAuthTokens = {
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token,
        expiresAt: Date.now() + refreshed.expires_in * 1000,
        scopes: refreshed.scope.split(" "),
        accountEmail: refreshed.account?.email_address || null,
        orgName: refreshed.organization?.name || null,
      };
      this.tokenCache.set(userId, newTokens);

      logger.info({ userId }, "Claude OAuth: token refreshed (deduped in-process)");
      return refreshed.access_token;
    } catch (err) {
      logger.error({ err, userId }, "Claude OAuth: refresh failed");
      this.tokenCache.delete(userId);
      await this.markDisconnected(userId);
      return null;
    }
  }

  /**
   * Invalidate the in-memory cache for a user.
   * Call this when tokens are known to be invalid (e.g. 401 from external service).
   */
  invalidateCache(userId: number): void {
    this.tokenCache.delete(userId);
  }

  /**
   * Check if the user has a Claude OAuth connection.
   */
  async isConnected(userId: number): Promise<{
    connected: boolean;
    email?: string;
    expiresAt?: number;
  }> {
    const stored = await this.loadTokens(userId);
    if (!stored) return { connected: false };

    const isExpired = stored.expiresAt <= Date.now();
    const hasRefresh = !!stored.refreshToken;

    return {
      connected: !isExpired || hasRefresh,
      email: stored.accountEmail || undefined,
      expiresAt: stored.expiresAt,
    };
  }

  /**
   * Disconnect the user's Claude OAuth.
   */
  async disconnect(userId: number): Promise<void> {
    this.tokenCache.delete(userId);
    await query(
      `DELETE FROM oauth_tokens WHERE user_id = $1 AND provider = 'claude'`,
      [userId]
    );
    logger.info({ userId }, "Claude OAuth: disconnected");
  }

  /**
   * Check if there's a pending auth flow (user started OAuth connect but hasn't pasted code yet).
   */
  hasPendingAuth(): boolean {
    return this.pendingAuths.size > 0;
  }

  // ==================== PRIVATE METHODS ====================

  private async refreshTokens(refreshToken: string): Promise<TokenResponse> {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: TOKEN_EXCHANGE_HEADERS,
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Refresh failed (HTTP ${response.status}): ${body}`);
    }

    return (await response.json()) as TokenResponse;
  }

  private async saveTokens(
    userId: number,
    tokens: TokenResponse
  ): Promise<void> {
    await this.saveTokensWithQuery(query, userId, tokens);
  }

  private async saveTokensWithQuery(
    q: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number }>,
    userId: number,
    tokens: TokenResponse
  ): Promise<void> {
    const expiresAt = Date.now() + tokens.expires_in * 1000;
    const scopes = tokens.scope.split(" ");
    const email = tokens.account?.email_address || null;
    const orgName = tokens.organization?.name || null;

    await q(
      `INSERT INTO oauth_tokens (user_id, provider, access_token, refresh_token, expires_at, scopes, account_email, org_name, updated_at)
       VALUES ($1, 'claude', $2, $3, $4, $5, $6, $7, NOW())
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
        JSON.stringify(scopes),
        email,
        orgName,
      ]
    );
  }

  private async loadTokens(userId: number): Promise<OAuthTokens | null> {
    const result = await query(
      `SELECT access_token, refresh_token, expires_at, scopes, account_email, org_name
       FROM oauth_tokens 
       WHERE user_id = $1 AND provider = 'claude' AND is_active = TRUE`,
      [userId]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      expiresAt: Number(row.expires_at),
      scopes: typeof row.scopes === "string" ? JSON.parse(row.scopes) : row.scopes,
      accountEmail: row.account_email,
      orgName: row.org_name,
    };
  }

  private async markDisconnected(userId: number): Promise<void> {
    this.tokenCache.delete(userId);
    await query(
      `UPDATE oauth_tokens SET is_active = FALSE, updated_at = NOW()
       WHERE user_id = $1 AND provider = 'claude'`,
      [userId]
    );
  }
}
