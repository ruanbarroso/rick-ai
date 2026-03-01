/**
 * Classification result from Rick's task classifier.
 * Simplified: no more code/research distinction.
 */
export interface TaskClassification {
  /** Brief description of what the sub-agent should do */
  taskDescription: string;
  /** The original user message */
  userMessage: string;
  /** Credential hints — services/accounts the task likely needs access to */
  credentialHints: string[];
}

/**
 * A pending delegation waiting for the user to provide credentials.
 */
export interface PendingDelegation {
  userMessage: string;
  /** Credentials already resolved from memory: key=service, value=credential data */
  resolvedCredentials: Record<string, string>;
  /** Credential names still missing */
  missingCredentials: string[];
  /** Which connector originated this delegation (for routing output back) */
  connectorName: string;
  /** Canonical user ID for routing output back */
  userId: string;
  createdAt: number;
}

/**
 * Sub-agent session state.
 */
export type SessionState =
  | "starting"     // Container being created
  | "running"      // Sub-agent is working on task
  | "waiting_user" // Sub-agent asked a question, waiting for user reply
  | "done"         // Task complete, showing output, waiting for user OK
  | "killed";      // Container destroyed

/**
 * Represents an active sub-agent session.
 */
export interface SubAgentSession {
  id: string;
  containerId: string | null;
  containerName: string;
  state: SessionState;
  /** The user's original task description (no credentials — safe to log) */
  taskDescription: string;
  /** Resolved credentials for the task (never logged) */
  credentials: Record<string, string>;
  /** Which connector originated this session (for routing output back) */
  connectorName: string;
  /** Canonical user ID for routing output back (phone or "owner") */
  userId: string;
  /** Numeric user ID from the users table (RBAC) — null for legacy sessions */
  numericUserId: number | null;
  /** Accumulated output from the sub-agent */
  output: string;
  /** Last text emitted via "message" event — used to deduplicate "done" result */
  lastMessageText?: string;
  /** Pending question from sub-agent to user */
  pendingQuestion: string | null;
  createdAt: number;
  updatedAt: number;
}
