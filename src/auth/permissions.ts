/**
 * RBAC permission definitions and checking functions.
 *
 * Roles:
 *   - admin: full access (web UI, chat, learn, secrets, sub-agents)
 *   - dev: chat + learn + sub-agents, no secrets visibility, no web UI
 *   - business: chat only, no learning, no sub-agents, no secrets
 *   - internal: system user for webhooks/schedules — chat + learn + sub-agents, no UI
 *   - null: pending user, no access
 *
 * Permissions are checked at multiple layers:
 *   - Connector layer: blocks messages from unauthorized users
 *   - Agent layer: restricts capabilities based on role
 *   - Memory layer: enforces hierarchy (admin > dev) on writes
 */

// ==================== Types ====================

export type UserRole = "admin" | "dev" | "business" | "internal" | null;
export type UserStatus = "pending" | "active" | "blocked";

// ==================== Permission Matrix ====================

const PERMISSIONS = {
  admin: {
    webUI: true,
    chat: true,
    learn: true,
    secrets: true,
    subAgents: true,
  },
  dev: {
    webUI: false,
    chat: true,
    learn: true,
    secrets: false,
    subAgents: true,
  },
  business: {
    webUI: false,
    chat: true,
    learn: false,
    secrets: false,
    subAgents: false,
  },
  internal: {
    webUI: false,
    chat: true,
    learn: true,
    secrets: false,
    subAgents: true,
  },
} as const;

// ==================== Permission Checks ====================

/** Whether the user can access the Web UI. */
export function canUseWebUI(role: UserRole): boolean {
  return role !== null && PERMISSIONS[role]?.webUI === true;
}

/** Whether the user can chat with Rick. */
export function canChat(role: UserRole): boolean {
  return role !== null && PERMISSIONS[role]?.chat === true;
}

/**
 * Whether Rick should learn from this user's conversations.
 * Controls both auto-extraction of memories and auto-embedding.
 */
export function canLearn(role: UserRole): boolean {
  return role !== null && PERMISSIONS[role]?.learn === true;
}

/**
 * Whether the user can view/create/delete secrets (sensitive memories).
 * When false, the LLM is instructed to never reveal secret values.
 * Sub-agents can still USE secrets internally even for non-admin users.
 */
export function canViewSecrets(role: UserRole): boolean {
  return role !== null && PERMISSIONS[role]?.secrets === true;
}

/** Whether the user can invoke sub-agents (task delegation). */
export function canInvokeSubAgent(role: UserRole): boolean {
  return role !== null && PERMISSIONS[role]?.subAgents === true;
}

/** Whether the user can manage automations (webhooks, schedules). Admin and dev only. */
export function canManageAutomations(role: UserRole): boolean {
  return role === "admin" || role === "dev";
}

// ==================== Hierarchy ====================

/**
 * Role authority level for memory hierarchy.
 * Higher number = higher authority.
 * Admin memories cannot be overwritten by dev.
 */
const ROLE_AUTHORITY: Record<string, number> = {
  admin: 100,
  dev: 50,
  internal: 40,
  business: 10,
};

/**
 * Get the authority level of a role.
 * Used to enforce memory hierarchy (admin > dev).
 */
export function getRoleAuthority(role: UserRole): number {
  if (!role) return 0;
  return ROLE_AUTHORITY[role] ?? 0;
}

/**
 * Whether `actor` has equal or higher authority than `target`.
 * Used for memory write checks.
 */
export function hasAuthorityOver(actorRole: UserRole, targetRole: UserRole): boolean {
  return getRoleAuthority(actorRole) >= getRoleAuthority(targetRole);
}
