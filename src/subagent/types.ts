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

export const SUBAGENT_MODELS = [
  { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { id: "gpt-5.3-codex", label: "GPT 5.3 Codex" },
  { id: "gemini-3.1-pro", label: "Gemini 3.1 Pro" },
] as const;

export type SubAgentModelId = (typeof SUBAGENT_MODELS)[number]["id"];

export const DEFAULT_SUBAGENT_MODEL: SubAgentModelId = "claude-opus-4-6";

export const SUBAGENT_EXECUTION_MODES = ["build", "plan"] as const;
export type SubAgentExecutionMode = (typeof SUBAGENT_EXECUTION_MODES)[number];
export const DEFAULT_SUBAGENT_EXECUTION_MODE: SubAgentExecutionMode = "build";

export function isSubAgentExecutionMode(value: string): value is SubAgentExecutionMode {
  return SUBAGENT_EXECUTION_MODES.includes(value as SubAgentExecutionMode);
}

export function isSubAgentModelId(value: string): value is SubAgentModelId {
  return SUBAGENT_MODELS.some((model) => model.id === value);
}

/**
 * Sub-agent session state.
 */
export type SessionState =
  | "starting"     // Container being created
  | "running"      // Sub-agent is working on task
  | "waiting_user" // Sub-agent asked a question, waiting for user reply
  | "done"         // Task complete, showing output, waiting for user OK
  | "failed"       // Sub-agent crashed (non-zero exit code)
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
  /** Assigned variant name for this session (e.g. "Pickle Rick", "Zoe Alpha") */
  variantName?: string;
  /** Preferred primary model for this session's cascade order. */
  preferredModel: SubAgentModelId;
  /** Execution mode for this session: build (execute) or plan (no writes). */
  executionMode: SubAgentExecutionMode;
  /** True if this session was recovered after a server restart */
  recovered?: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Runtime telemetry snapshot for sub-agent reliability/rollout monitoring. */
export interface SubAgentMetricsSnapshot {
  startedAt: number;
  gauges: {
    liveSessions: number;
    runningSessions: number;
    waitingUserSessions: number;
    doneSessions: number;
    failedSessions: number;
  };
  counters: {
    sessionsCreated: number;
    sessionsRecovered: number;
    sessionsKilled: number;
    sessionsInterrupted: number;
    sessionsFailed: number;
    turnsCompleted: number;
    providerErrors: number;
    fallbackUsed: number;
    timeoutRetries: number;
    authRetries: number;
    maxStepsHits: number;
    contextCompactions: number;
    noExecutionGuards: number;
    toolCallsStarted: number;
    toolCallsCompleted: number;
    toolCallsErrored: number;
  };
  /** Summary of live sessions for the active-sessions modal (no credentials). */
  liveSessionsList?: Array<{
    id: string;
    state: SessionState;
    taskDescription: string;
    variantName?: string;
    connectorName: string;
    userId: string;
    sessionsToken?: string;
    createdAt: number;
    updatedAt: number;
  }>;
}
