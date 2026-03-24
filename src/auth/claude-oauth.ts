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
  "Accept": "application/json",
  "anthropic-beta": "oauth-2025-04-20",
  "user-agent": "claude-cli/2.1.80 (external, cli)",
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

function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(
    createHash("sha256").update(codeVerifier).digest()
  );
  return { codeVerifier, codeChallenge };
}

// ==================== CLAUDE OAUTH SERVICE ====================

/** Cache key for shared (user_id=NULL) tokens. Maps can't use null as a key. */
const SHARED_CACHE_KEY = -1;

/** Convert userId (number|null) to a cache map key. */
function cacheKey(userId: number | null): number {
  return userId ?? SHARED_CACHE_KEY;
}

export class ClaudeOAuthService {
  /**
   * In-memory storage for pending auth flows.
   * Keyed by state. Expires after 10 minutes.
   */
  private pendingAuths = new Map<string, PendingAuth>();

  /**
   * In-memory token cache keyed by userId (or SHARED_CACHE_KEY for shared tokens).
   * Avoids hitting DB and refresh endpoint on every getValidToken() call.
   * All callers (sub-agents, etc.) share this cache.
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
    const { codeVerifier, codeChallenge } = generatePKCE();
    // Use the codeVerifier as the state parameter (matches opencode plugin behavior)
    const state = codeVerifier;

    // Store PKCE verifier for later exchange
    this.pendingAuths.set(state, {
      codeVerifier,
      state,
      createdAt: Date.now(),
    });

    const params = new URLSearchParams({
      code: "true", // Shows the code on screen for user to copy
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
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
    userId: number | null,
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

    // Exchange code for tokens.
    // This follows the working flow mirrored from the portal-renderer OAuth fix:
    // - JSON body
    // - anthropic-beta header
    // - claude-cli style user-agent
    try {
      const response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: TOKEN_EXCHANGE_HEADERS,
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          code_verifier: pending.codeVerifier,
          client_id: CLIENT_ID,
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
      this.tokenCache.set(cacheKey(userId), {
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
  async getValidToken(userId: number | null, forceRefresh = false): Promise<string | null> {
    const ck = cacheKey(userId);
    // 1. Check in-memory cache first (skip when force-refreshing, e.g. after 401)
    if (!forceRefresh) {
      const cached = this.tokenCache.get(ck);
      if (cached && cached.expiresAt > Date.now() + EXPIRY_BUFFER_MS) {
        return cached.accessToken;
      }
    } else {
      this.tokenCache.delete(ck);
    }

    // 2. Cache miss or expired — load from DB
    const stored = await this.loadTokens(userId);
    if (!stored) {
      this.tokenCache.delete(ck);
      return null;
    }

    // 3. Token still valid? Update cache and return (skip when force-refreshing)
    if (!forceRefresh && stored.expiresAt > Date.now() + EXPIRY_BUFFER_MS) {
      this.tokenCache.set(ck, stored);
      return stored.accessToken;
    }

    // 4. Token expired (or force refresh) — need refresh. Deduplicate concurrent refreshes.
    if (!stored.refreshToken) {
      logger.warn({ userId }, "Claude OAuth: no refresh token, disconnecting");
      this.tokenCache.delete(ck);
      await this.disconnect(userId);
      return null;
    }

    // If a refresh is already in progress for this user, wait for it
    const existing = this.refreshInProgress.get(ck);
    if (existing) {
      return existing;
    }

    // Start the refresh and store the promise so others can wait on it
    const refreshPromise = this.doRefresh(userId, stored.refreshToken);
    this.refreshInProgress.set(ck, refreshPromise);

    try {
      return await refreshPromise;
    } finally {
      this.refreshInProgress.delete(ck);
    }
  }

  /**
   * Actually perform the token refresh. Separated to allow deduplication.
   */
  private async doRefresh(userId: number | null, refreshToken: string): Promise<string | null> {
    const ck = cacheKey(userId);
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
      this.tokenCache.set(ck, newTokens);

      logger.info({ userId }, "Claude OAuth: token refreshed (deduped in-process)");
      return refreshed.access_token;
    } catch (err: any) {
      const errMsg = String(err?.message || "");
      logger.error({ err, userId }, "Claude OAuth: refresh failed");
      this.tokenCache.delete(ck);

      // Only permanently disable the token for definitive errors.
      // Temporary errors (429, timeout, network) should NOT disable the token —
      // it may still be refreshable later. The shared token (user_id=NULL) is
      // especially critical and must not be killed by a transient failure.
      const isDefinitive =
        errMsg.includes("invalid_grant") ||
        errMsg.includes("unauthorized_client") ||
        errMsg.includes("revoked") ||
        errMsg.includes("HTTP 400") ||
        errMsg.includes("HTTP 401");

      if (isDefinitive) {
        logger.warn({ userId, errMsg }, "Claude OAuth: definitive refresh failure — marking disconnected");
        await this.markDisconnected(userId);
      } else {
        logger.info({ userId, errMsg }, "Claude OAuth: transient refresh failure — keeping token active for retry");
      }
      return null;
    }
  }

  /**
   * Returns OAuth bundle in OpenCode-compatible shape.
   * Ensures token freshness first, then returns access+refresh+expiry.
   */
  async getAuthBundle(userId: number | null, forceRefresh = false): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  } | null> {
    const accessToken = await this.getValidToken(userId, forceRefresh);
    if (!accessToken) return null;

    const stored = await this.loadTokens(userId);
    if (!stored?.refreshToken) return null;

    return {
      accessToken,
      refreshToken: stored.refreshToken,
      expiresAt: stored.expiresAt,
    };
  }

  /**
   * Invalidate the in-memory cache for a user.
   * Call this when tokens are known to be invalid (e.g. 401 from external service).
   */
  invalidateCache(userId: number | null): void {
    this.tokenCache.delete(cacheKey(userId));
  }

  /**
   * Check if the user has a Claude OAuth connection.
   */
  async isConnected(userId: number | null): Promise<{
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
  async disconnect(userId: number | null): Promise<void> {
    this.tokenCache.delete(cacheKey(userId));
    if (userId == null) {
      await query(`DELETE FROM oauth_tokens WHERE user_id IS NULL AND provider = 'claude'`);
    } else {
      await query(`DELETE FROM oauth_tokens WHERE user_id = $1 AND provider = 'claude'`, [userId]);
    }
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
    userId: number | null,
    tokens: TokenResponse
  ): Promise<void> {
    await this.saveTokensWithQuery(query, userId, tokens);
  }

  private async saveTokensWithQuery(
    q: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number }>,
    userId: number | null,
    tokens: TokenResponse
  ): Promise<void> {
    const expiresAt = Date.now() + tokens.expires_in * 1000;
    const scopes = tokens.scope.split(" ");
    const email = tokens.account?.email_address || null;
    const orgName = tokens.organization?.name || null;

    // Use COALESCE(user_id, 0) for the unique constraint to handle NULL (shared tokens)
    await q(
      `INSERT INTO oauth_tokens (user_id, provider, access_token, refresh_token, expires_at, scopes, account_email, org_name, updated_at)
       VALUES ($1, 'claude', $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (COALESCE(user_id, 0), provider)
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

  private async loadTokens(userId: number | null): Promise<OAuthTokens | null> {
    const result = userId == null
      ? await query(
          `SELECT access_token, refresh_token, expires_at, scopes, account_email, org_name
           FROM oauth_tokens 
           WHERE user_id IS NULL AND provider = 'claude' AND is_active = TRUE`)
      : await query(
          `SELECT access_token, refresh_token, expires_at, scopes, account_email, org_name
           FROM oauth_tokens 
           WHERE user_id = $1 AND provider = 'claude' AND is_active = TRUE`,
          [userId]);

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

  private async markDisconnected(userId: number | null): Promise<void> {
    this.tokenCache.delete(cacheKey(userId));
    if (userId == null) {
      await query(`UPDATE oauth_tokens SET is_active = FALSE, updated_at = NOW() WHERE user_id IS NULL AND provider = 'claude'`);
    } else {
      await query(`UPDATE oauth_tokens SET is_active = FALSE, updated_at = NOW() WHERE user_id = $1 AND provider = 'claude'`, [userId]);
    }
  }
}
