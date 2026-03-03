# Rick — Personal AI Agent on WhatsApp & Web

Rick is a multi-user personal AI assistant that runs on WhatsApp and a Web UI. Multiple users can interact with Rick through WhatsApp, each with role-based access control (RBAC). The admin manages users and has full access through the Web UI.

Built on Oracle Cloud Always Free VMs, Rick orchestrates multiple LLM providers and spawns isolated Docker containers with a unified sub-agent that can browse the web, run shell commands, read/write files, and query databases.

## Architecture

```
 WhatsApp (multi-user)       Web UI (admin only)
        │                            │
   WhatsApp Connector          Web Connector
   + UserService               (WebSocket)
        │                            │
        └──────────┬─────────────────┘
            ConnectorManager
                 │
             Agent (orchestrator)
                 │
     ┌───────────┼──────────────────────┐
     │           │                      │
 Classifier   LLMService          MemoryService
 (Gemini)    (multi-LLM)        (PG/SQLite + pgvector)
     │           │                      │
     ▼           ▼                      │
 SessionManager  OAuth            UserService
     │        (Claude/GPT)         (RBAC)
     ▼                                  │
  Unified Sub-Agent Container           │
  (Claude→GPT→Gemini 3.1 Pro)           │
  (Browser + Shell + Files + DB)        │
```

### How a message flows

1. **Connector** (WhatsApp or Web) receives a message, resolves the user via `UserService` (connector identity → user record), and wraps it as an `IncomingMessage` with RBAC fields (`numericUserId`, `userRole`, `userStatus`)
2. If user is **pending** or **blocked**: message is saved for admin visibility, but no LLM processing occurs. New pending users trigger a badge update in the admin's Web UI.
3. **Agent.handleMessage()** serializes per user (message queue prevents race conditions) and routes it:
   - `/commands` → slash command handler
   - Edit mode active → Claude Code container
   - Audio → transcribed to text via Gemini, then routed normally
   - Active sub-agent session → relay (continuation, close, or nag)
   - Classification skipped for **business** users (cannot invoke sub-agents)
   - Otherwise → **Classifier** decides: `SELF` (direct chat) or `DELEGATE` (sub-agent)
4. For `SELF`: Gemini Flash responds with user-isolated conversation history + global memory context (secrets filtered for non-admin). Learning (memory extraction + embedding) only occurs if `canLearn(role)`.
5. For `DELEGATE`: a unified Docker container is spawned with all LLM providers, credentials injected, output streamed back via the originating connector. Session persisted to `sub_agent_sessions` for audit.

## Features

### Role-Based Access Control (RBAC)

Rick supports multiple users with different roles:

| Role | Chat | Learning | Sub-agents | View Secrets | Web UI |
|------|:----:|:--------:|:----------:|:------------:|:------:|
| **Admin** | Yes | Yes | Yes | Yes | Yes |
| **Dev** | Yes | Yes | Yes | No (sub-agents use them internally) | No |
| **Business** | Yes | No | No | No | No |

- **Admin**: Single user, fixed at installation, manages all users via Web UI
- **Dev**: Chat + teach Rick + sub-agents via WhatsApp/connectors
- **Business**: Chat only via WhatsApp/connectors
- **Pending**: New users start with no role. Their messages are saved but not processed until the admin assigns a role.

Users are resolved via `connector_identities` — the same physical user can connect through multiple connectors (WhatsApp, future Discord/Telegram).

Memories are **global** (shared across all users), with `created_by` tracking and hierarchy enforcement: admin memories cannot be overwritten by dev users. Dev-dev conflicts are handled by the LLM via system prompt instructions.

### Multi-Connector Architecture

Rick supports multiple messaging platforms through a connector abstraction:

| Connector | Features |
|-----------|----------|
| **WhatsApp** | Multi-user via Baileys v7, RBAC user resolution, polls, audio/image media, typing indicators |
| **Web UI** | Admin-only, password-protected WebSocket chat, user management panel, audio recording, image upload, settings panel, session viewer, OAuth flows, QR code display |

Connectors are managed by the `ConnectorManager`, which routes messages bidirectionally between connectors and the Agent core. New connectors (Discord, Telegram, etc.) can be added by implementing the `Connector` interface.

### Multi-LLM Routing

| Model | Provider | Used For |
|-------|----------|----------|
| Gemini 3.0 Flash | Google | Default chat, classifier, audio transcription, memory extraction |
| Claude Opus 4.6 | Anthropic | Sub-agent primary (via OAuth), edit mode |
| GPT-5.3 Codex | OpenAI | Sub-agent fallback (via OAuth) |
| Gemini 3.1 Pro | Google | Sub-agent fallback |

No API keys needed for Claude or GPT — Rick uses OAuth 2.0 + PKCE to connect via your existing Pro/Max subscriptions. API key fallback models (`claude-opus-4-6`, `gpt-5.3-codex`) are used when OAuth is not configured.

OAuth refresh is coordinated with in-memory deduplication per provider/user, avoiding duplicate refresh calls within the running Rick instance.

### Persistent Memory

Rick has two memory systems working together:

- **Structured memory** (PostgreSQL or SQLite) — key-value pairs organized by category (credentials, knowledge, notes, preferences). Global across all users with `created_by` audit tracking. Supports exact match, Portuguese full-text search, and ILIKE fallback.
- **Semantic memory** (pgvector) — conversation embeddings via Gemini's embedding model (768 dimensions, HNSW index). Global with `created_by` tracking and creator role info. Enables "search by meaning" for past conversations.

Memories are extracted automatically:
- Regex patterns catch credential cases ("minha senha do github e...")
- LLM extraction (Gemini Flash) handles complex cases when the assistant confirms saving something
- Personal data (name, email, city) goes to `users.profile` JSONB, NOT memories
- Every non-trivial conversation is embedded into vector memory (global, with `created_by`)
- RBAC hierarchy: admin memories cannot be overwritten by dev users

Credential memories are protected: partial extractions cannot overwrite richer existing values (smart merge). Non-admin users cannot view secret values (but sub-agents can use them internally).

Credentials in sensitive categories (`senhas`, `credenciais`, `tokens`, `passwords`, `secrets`) are **encrypted at rest** with AES-256-GCM. The encryption key is derived from `MEMORY_ENCRYPTION_KEY` via scrypt. Encrypted values are stored as `enc:iv:authTag:ciphertext` and decrypted transparently on read. Legacy plaintext values are handled gracefully (backward-compatible).

Tables are automatically pruned to prevent unbounded growth:
- `conversations`: capped at 500 messages per user
- `message_log`: capped at 5000 entries globally

**SQLite fallback**: When `DATABASE_URL` is not set, Rick automatically uses SQLite for structured memory, so PostgreSQL is not strictly required for development/testing.

### Unified Sub-Agent

All delegated tasks (coding, research, browser automation) are handled by a **single unified sub-agent** container with:

- **LLM cascade**: Claude Opus 4.6 → GPT-5.3 Codex → Gemini 3.1 Pro (automatic failover on rate limits or errors, with automatic retry on timeout before falling through). Providers are re-evaluated per turn, so a session started with only Gemini will automatically gain Claude/GPT access when they are connected later via OAuth. Conversation context is shared across providers via a common transcript, so a cascade switch does not cause amnesia.
- **Tools**: Browser (Playwright + headless Chromium), shell commands, file I/O, HTTP fetch, read-only PostgreSQL access
- **NDJSON protocol**: stdin/stdout communication with the main Rick process for real-time streaming
- **Context rotation**: Automatic summarization when context window fills up
- **Credential injection**: OAuth tokens and stored passwords injected at runtime (never in task descriptions). Sensitive memories are pre-resolved and injected as `RICK_SECRET_*` env vars (decrypted, no encryption key exposed).
- **Agent API access**: Each sub-agent receives a signed JWT (`RICK_SESSION_TOKEN`) and API URL (`RICK_API_URL`) to query Rick's read-only API for memories, credentials, semantic search, conversations, and config — all scoped to the owner's data.
- **Session recovery**: Running containers are recovered after Rick restarts
- **Image freshness**: `subagent` image is rebuilt automatically whenever bundle hash or Rick version label differs (no stale image reuse across versions)
- **Centralized image builder**: main container warms the `subagent` image in background at startup; new sessions reuse `subagent:current`, while a new version builds in the background and is promoted atomically when ready

Each sub-agent gets a unique variant name assigned sequentially per user. When `AGENT_NAME=Rick`, names come from canonical Rick and Morty characters (Pickle Rick, Evil Rick, Doofus Rick, etc. — 130+ variants). For other agent names, generic suffixes are used (Alpha, Beta, Quantum, Nebula, etc. — 90+ variants). Names are persisted in the `variant_name` column and served to all clients from the server.

### Self-Editing (edit mode)

Rick can edit his own source code. Edit mode is entered via a hidden easter egg: **triple-click on the agent avatar** in the web UI sidebar. Requires a GitHub Token and at least one AI provider (Claude/GPT/Gemini) to be configured.

1. **Enter edit mode** — Triple-click the agent avatar. Creates a staging copy of the repository excluding runtime artifacts and local data (`.git`, `node_modules`, `dist`, `data`, `auth_info`, `.env`), launches the `subagent-edit` container (auto-built on first run). Provider priority: **Claude Code → GPT-5.3 Codex → Gemini 3.1 Pro**, chosen automatically based on which credentials are available.
   - `subagent-edit` image is warmed up in background at startup and auto-rebuilt when source hash/version labels differ; edit mode always waits for the current image (never runs with stale image).
2. Send prompts describing what to change — the active provider edits the files directly inside the isolated container.
3. `/deploy` — Triggers the deploy pipeline:
   - Backup current `src/` → build candidate image → smoke test (health-only mode) → swap containers → 60s watchdog → rollback on failure
4. `/publish [usuario/repo]` — Deploy + push code to GitHub. Defaults to `ruanbarroso/rick-ai`. Resolves GitHub token from Rick's memories, validates write access, runs the full deploy pipeline, then pushes. Push strategy: fast-forward → rebase → `--force-with-lease`.
5. **Exit edit mode** — Triple-click the Evil Morty avatar (shown while in edit mode). Discards uncommitted changes.

### Web UI

The Web UI (`https://rick.barroso.tec.br`) provides a full browser-based interface (admin only):

- **Chat**: Send text, record audio (transcribed via Gemini), upload images (single or multi-image)
- **User management**: View pending/active/blocked users, assign roles (dev/business), block/unblock, view user profiles, conversation history, and sub-agent sessions. Pending user badge with real-time count updates.
- **Sub-agent sessions**: View active sessions, send follow-up messages, kill sessions, view session history
- **Public main-session viewer**: Shareable link (`/m/:token`) for real-time main conversation with full media support (text, audio recording, file attachments, paste images)
- **Public session viewer**: Shareable link (`/s/:sessionId`) for real-time sub-agent output
- **Public sessions dashboard**: Per-user sessions list (`/u/:token`) with all sessions ordered by last activity, linking to individual session viewers
- **Settings panel**: View/edit API keys, database URLs, agent config — all persisted via config store
- **OAuth management**: Connect/disconnect Claude and GPT directly from the web
- **WhatsApp management**: View QR code, disconnect/reconnect WhatsApp
- **Version management**: Check current version, check for updates from GitHub, install updates (OTA)
- **Developer tools**: Export/import source code (hidden behind easter egg — 5 rapid clicks on version text)

### Audio & Image Support

- **Audio** — Transcribed via Gemini Flash multimodal API, then routed through the normal pipeline (commands, classifier, sub-agents).
- **Images** — Passed to Gemini Flash for visual understanding in chat, or injected into sub-agent containers.

### Session Management

Sub-agent sessions have a lifecycle: `starting` → `running` → `waiting_user` → `done` → `killed`.

- When a task finishes, Rick sends a "Posso encerrar?" poll (or numbered list on Web UI)
- Follow-up messages are detected via topic matching (shared keywords + demonstrative references)
- Context is preserved across follow-ups: original task description + previous output + credentials are passed to the sub-agent
- Multiple close commands recognized: "ok", "pronto", "encerrar", "pode encerrar", "encerrar tudo"

### Interaction

There are no slash commands — all interaction is via natural language. The agent understands requests in Portuguese and English:

- **Memories**: "Lembra que meu email é x@y.com", "O que voce sabe sobre mim?"
- **Sub-agents**: Complex tasks (coding, web research, email) are automatically delegated to sub-agents
- **OAuth/Settings**: Managed via the web UI settings panel
- **Edit mode**: Enter/exit via triple-click on the agent avatar (easter egg)

**Edit mode only commands** (used inside edit mode, not in normal conversation):

| Command | Description |
|---------|-------------|
| `/deploy` | Deploy staged changes (build + smoke test + swap + watchdog) |
| `/publish [user/repo]` | Deploy + push to GitHub (default: `ruanbarroso/rick-ai`) |

### HTTP Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | None | Health check (JSON: status, uptime, WhatsApp/Postgres/pgvector) |
| `/` | GET | None | Web UI (single HTML page) |
| `/m/:token` | GET | None | Public main-session viewer (per-user, text + audio + files) |
| `/s/:sessionId` | GET | None | Public sub-agent session viewer |
| `/u/:token` | GET | None | Public sessions dashboard (per-user, deterministic token) |
| `/api/sessions/:token` | GET | None | Sessions list API (returns JSON with user's sessions) |
| `/api/sessions/:token/kill/:sessionId` | POST | None | Kill an active session (validates token ownership) |
| `/audio/:id` | GET | None | Serve stored audio blob |
| `/img/:id` | GET | None | Serve stored image blob |
| `/api/version` | GET | Token | Current version vs GitHub latest |
| `/api/code/export` | GET | Token | Download source as tar.gz |
| `/api/code/import` | POST | Token | Upload archive + deploy with rollback |
| `/api/update` | POST | Token | Download latest from GitHub + deploy with rollback |
| `/api/agent/config` | GET | JWT | Sub-agent: operational config (name, language, owner) |
| `/api/agent/memories` | GET | JWT | Sub-agent: list memories (decrypted). Optional `?category=x` |
| `/api/agent/memory` | GET | JWT | Sub-agent: get specific memory. `?category=x&key=y` |
| `/api/agent/search` | GET | JWT | Sub-agent: semantic vector search. `?q=text&limit=5` |
| `/api/agent/conversations` | GET | JWT | Sub-agent: recent conversation history. `?limit=20` |

WebSocket endpoints:

| Endpoint | Auth | Description |
|----------|------|-------------|
| `ws://host/ws` | Password | Authenticated Web UI real-time chat + settings + user management |
| `ws://host/ws/main?t=<token>` | Token | Public main-session viewer real-time chat (text + audio + files) |
| `ws://host/ws/session?id=<id>` | None | Public session viewer real-time messages |

WebSocket message types (admin-only, via `/ws`):

| Type | Direction | Description |
|------|-----------|-------------|
| `get_users` | Client→Server | List all users (pending, active, blocked) |
| `get_pending_count` | Client→Server | Get count of pending users |
| `get_user_detail` | Client→Server | Get full user profile + identities |
| `set_user_role` | Client→Server | Assign role (dev/business) to user |
| `block_user` | Client→Server | Block a user |
| `unblock_user` | Client→Server | Unblock a user |
| `update_user_profile` | Client→Server | Update user profile and display name |
| `get_user_conversations` | Client→Server | Get user's conversation history |
| `get_user_sessions` | Client→Server | Get user's sub-agent sessions |
| `pending_count` | Server→Client | Push pending user count (on new user) |
| `users` | Server→Client | User list response |
| `user_detail` | Server→Client | User detail response |
| `user_updated` | Server→Client | User updated confirmation |

## Project Structure

```
rick-ai/
├── src/
│   ├── index.ts                       # Entry point (bootstrap)
│   ├── agent.ts                       # Core orchestrator
│   ├── health.ts                      # HTTP server (health, web UI, API endpoints, media)
│   ├── types.d.ts                     # Ambient type declarations
│   ├── config/
│   │   ├── env.ts                     # Environment config (hot-reloadable)
│   │   └── logger.ts                  # Pino logger
│   ├── connectors/
│   │   ├── connector-manager.ts       # Multi-connector orchestrator
│   │   ├── types.ts                   # Connector interface, IncomingMessage, capabilities
│   │   ├── whatsapp.ts                # WhatsApp connector (Baileys v7, self-chat, polls, media)
│   │   ├── web.ts                     # Web UI connector (WebSocket, settings, sessions, OAuth)
│   │   ├── web-ui.html                # Web UI frontend (single HTML file)
│   │   ├── main-session-viewer.html   # Public main-session viewer page (text + audio + files)
│   │   ├── session-viewer.html        # Public sub-agent session viewer page (text + audio + files)
│   │   ├── sessions-list.html        # Public sessions dashboard (per-user)
│   │   └── static/                    # Shared assets served at /static/
│   │       ├── render-text.js         # Markdown→HTML, media rendering, image fullscreen
│   │       ├── tool-blocks.js         # Terminal-style tool-use blocks
│   │       └── tool-blocks.css        # Tool-use block styles
│   ├── llm/
│   │   ├── llm-service.ts             # Provider abstraction + model switching
│   │   ├── types.ts                   # Model registry + shared types
│   │   └── providers/
│   │       ├── gemini.ts              # Gemini (multimodal)
│   │       ├── anthropic.ts           # Anthropic (API key + OAuth)
│   │       └── openai.ts             # OpenAI (API key + Codex OAuth)
│   ├── auth/
│   │   ├── permissions.ts             # RBAC role types, permission matrix, hierarchy checks
│   │   ├── user-service.ts            # User resolution, CRUD, role management, welcome messages
│   │   ├── claude-oauth.ts            # Claude OAuth 2.0 + PKCE
│   │   └── openai-oauth.ts           # OpenAI OAuth 2.0 + PKCE
│   ├── memory/
│   │   ├── database.ts                # Unified DB abstraction (PostgreSQL + SQLite)
│   │   ├── db.ts                      # PostgreSQL pool (structured)
│   │   ├── memory-service.ts          # CRUD: memories, conversations, users, message tracking
│   │   ├── crypto.ts                  # AES-256-GCM encryption for sensitive memories
│   │   ├── migrate.ts                 # Schema migrations (structured DB)
│   │   ├── config-store.ts            # Runtime config store (persist settings via DB)
│   │   ├── vector-db.ts              # PostgreSQL pool (pgvector)
│   │   ├── vector-memory-service.ts  # Semantic search, dedup, eviction
│   │   ├── vector-migrate.ts         # Schema migrations (vector DB)
│   │   ├── embedding-service.ts      # Gemini embeddings (768 dims)
│   │   └── disk-monitor.ts           # Periodic DB size check + LRU eviction
│   └── subagent/
│       ├── classifier.ts              # Gemini Flash task classifier (SELF vs DELEGATE)
│       ├── types.ts                   # Session/task type definitions
│       ├── agent-token.ts             # JWT (HS256) token generation/verification for sub-agents
│       ├── session-manager.ts         # Docker container lifecycle, NDJSON relay
│       └── edit-session.ts            # Self-editing mode (Claude Code)
├── docker/
│   ├── subagent/                      # Unified sub-agent (current)
│   │   ├── Dockerfile                 # Chromium + Playwright + Node.js image
│   │   └── agent.mjs                  # Autonomous agent script (LLM cascade + tools)
│   ├── subagent-edit.Dockerfile       # Multi-provider edit image (Claude→GPT→Gemini, auto-built)
│   ├── rick-api.mjs                   # Shared: Rick API client, tool declarations, tool handler, timeout constants
│   └── edit-agent.mjs                 # Entry point: routes to Claude CLI / OpenAI / Gemini API
├── scripts/
│   └── deploy.sh                      # Safe deploy pipeline (backup → build → smoke → swap → watchdog)
├── Dockerfile                         # Main agent image (Node.js 22 + Docker CLI)
├── docker-compose.yml                 # Agent service definition
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
├── AGENTS.md                          # Instructions for AI agents contributing to this repo
├── CLAUDE.md                          # Instructions for Claude
└── GEMINI.md                          # Instructions for Gemini
```

## Infrastructure

All infrastructure runs on Oracle Cloud Always Free tier — zero cost.

| VM | Specs | Role | IP |
|----|-------|------|----|
| cluster-24g | ARM A1.Flex, 4 cores, 24 GB RAM | Rick + sub-agent containers | `137.131.219.123` |
| docker-1g (structured) | AMD Micro, 1 GB RAM | PostgreSQL (memories, conversations, users, OAuth) | `137.131.241.200` |
| docker-1g (vector) | AMD Micro, 1 GB RAM | pgvector (semantic embeddings) | `137.131.239.197` |

### Container Topology

```
Host Docker (cluster-24g)
│
├── rick-ai-agent-1                # Main Rick container (always running)
│   ├── Mounts docker.sock         # Creates/manages child containers
│   ├── Mounts auth_info/          # WhatsApp session persistence
│   ├── Mounts scripts/            # Deploy scripts (read-only)
│   └── Port 80                    # HTTP + WebSocket (web UI, health, API)
│
├── subagent-<id>                  # Ephemeral, created per task (unified)
│   └── agent.mjs + Playwright + Chromium
│
└── subagent-edit-*                # Ephemeral, created per edit session
    └── edit-agent.mjs (Claude Code CLI / GPT-5.3 Codex / Gemini 3.1 Pro) + Playwright
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GEMINI_API_KEY` | Yes | — | Google AI Studio API key |
| `GEMINI_MODEL` | No | `gemini-3-flash-preview` | Override Gemini model name |
| `ANTHROPIC_API_KEY` | No | — | Anthropic API key (alternative to OAuth) |
| `ANTHROPIC_MODEL` | No | `claude-opus-4-6` | Override Anthropic model name |
| `OPENAI_API_KEY` | No | — | OpenAI API key (alternative to OAuth) |
| `OPENAI_MODEL` | No | `gpt-5.3-codex` | Override OpenAI model name |
| `DATABASE_URL` | No | — | PostgreSQL connection string. If unset, Rick uses SQLite. |
| `VECTOR_DATABASE_URL` | No | — | pgvector connection string (semantic memory) |
| `MEMORY_ENCRYPTION_KEY` | No | — | Passphrase for AES-256-GCM encryption of credential memories. If unset, credentials stored as plaintext. |
| `WEB_AUTH_PASSWORD` | No | — | Password for Web UI authentication. Required for Web connector to start. |
| `WEB_BASE_URL` | No | — | Public base URL for session links (e.g., `https://rick.barroso.tec.br`) |
| `WEB_PORT` | No | `80` | Port for the HTTP + WebSocket server |
| `GITHUB_TOKEN` | No | — | GitHub Personal Access Token. Used for version checks (avoids rate limits), `/publish`, and sub-agents. Can also be set via Web UI settings. |
| `AGENT_NAME` | No | `Rick` | Agent display name |
| `AGENT_LANGUAGE` | No | `pt-BR` | Agent language |
| `OWNER_PHONE` | No | — | Owner's phone number for permission checks |
| `MAX_MEMORY_ITEMS` | No | `1000` | Max structured memories per user |
| `CONVERSATION_HISTORY_LIMIT` | No | `20` | Max messages in conversation context |
| `HOST_PROJECT_DIR` | No | `$PWD` | Host path to project dir (for edit mode / deploy). Auto-injected by docker-compose via `$PWD`. |
| `VECTOR_DB_MAX_SIZE_GB` | No | `36` | Max vector DB size in GB before eviction |
| `DISK_CHECK_INTERVAL_MINUTES` | No | `10` | Disk check interval in minutes |
| `HEALTH_ONLY` | No | — | When `true`, starts only health server + DB (no connectors). Used by deploy smoke test. |
| `LOG_LEVEL` | No | `info` | Pino log level |

Build-time arguments (injected via Docker):

| Variable | Description |
|----------|-------------|
| `COMMIT_SHA` | Git commit SHA, becomes `RICK_COMMIT_SHA` env var in container |
| `COMMIT_DATE` | Git commit date, becomes `RICK_COMMIT_DATE` env var in container |

## Database Schema

### Structured DB

```sql
users (id, phone, role, status, display_name, profile JSONB,
       last_activity_at, created_at, updated_at)
  -- role: NULL (pending) | 'admin' | 'dev' | 'business'
  -- status: 'pending' | 'active' | 'blocked'
connector_identities (id, user_id, connector, external_id, display_name, created_at)
  -- Maps connector-specific IDs to users (e.g., WhatsApp phone → user)
  -- UNIQUE (connector, external_id)
memories (id, category, key, value, metadata, user_id, created_by,
          created_at, updated_at)
  -- Global memories with RBAC hierarchy enforcement via created_by
  -- UNIQUE (category, key) -- global unique constraint
  -- GIN index on to_tsvector('portuguese', key || ' ' || value)
conversations (id, user_id, role, content, model_used, tokens_used, created_at)
  -- user_id for RBAC-aware history isolation
message_log (id, wa_message_id, author, content, created_at)
oauth_tokens (id, user_id, provider, access_token, refresh_token, expires_at, ...)
  -- UNIQUE (user_id, provider)
audio_blobs (id, data BYTEA, mime_type, created_at)
  -- Stores both audio and image binary data
session_messages (id, session_id, user_id, role, content, created_at)
  -- Sub-agent conversation history (preserved after kill for admin audit)
sub_agent_sessions (id, user_id, task, status, started_at, ended_at,
                    connector_name, user_external_id, variant_name)
  -- Persisted session audit trail (variant_name stores the assigned sub-agent display name)
config_store (key, value, updated_at)
  -- Runtime config persistence (API keys, settings from Web UI)
```

### Vector DB

```sql
memory_embeddings (id, content, category, source, embedding vector(768),
                   metadata, hit_count, last_hit_at, created_by, created_at)
  -- Global embeddings with created_by for RBAC context
  -- HNSW index (m=16, ef_construction=64, cosine distance)
```

## Deploy Pipeline

The deploy pipeline (`scripts/deploy.sh`) ensures safe self-editing:

```
1. Backup managed project tree (all non-artifact files)
2. Sync staged files from edit session (full tree minus artifacts and local data directories)
3. Build candidate Docker image (TypeScript errors = fail)
4. Start candidate in HEALTH_ONLY mode on port 8081
5. Health check (20 attempts, 3s apart)
6. If healthy → re-tag candidate as main image, docker compose up -d (no rebuild)
7. Watchdog: monitor health for up to 120s
8. On any failure → rollback (restore backup, rebuild)
```

Version is stamped at build time: `deploy.sh` reads the commit SHA and date from git (or `.rick-version` fallback) and passes them as Docker build args.

Exit codes: `0` = success, `1` = build fail, `2` = smoke test fail, `3` = watchdog fail (rollback OK), `4` = rollback also failed (CRITICAL).

### OTA Updates

Rick can update itself from GitHub without SSH access:

1. **Check for updates**: `GET /api/version` compares `RICK_COMMIT_SHA` with the latest commit on `main` via GitHub API. On success, Rick persists the last known latest version in a local cache file (`.rick-latest-version.json`).
2. **Install update**: `POST /api/update` downloads code from GitHub and runs the deploy pipeline with full rollback protection. If live version lookup fails temporarily, Rick falls back to the cached latest version (when available).
3. **Web UI**: The "Versao" section in settings shows current version, update availability, and an install button

## Quick Start

```bash
# 1. Clone and configure
git clone https://github.com/ruanbarroso/rick-ai.git
cd rick-ai
cp .env.example .env
# Edit .env with your GEMINI_API_KEY (minimum required)
# Optionally set DATABASE_URL, WEB_AUTH_PASSWORD, etc.

# 2. Build and start
docker compose up -d --build

# 3. Pair WhatsApp
docker compose logs -f agent
# Scan the QR code with WhatsApp (Linked Devices)

# 4. Message yourself on WhatsApp or open the Web UI
# Rick will respond to your self-chat messages
# Web UI available at http://localhost:80 (requires WEB_AUTH_PASSWORD)
```

## Security

- **No shell injection** — Sub-agent prompts are passed as direct `execve()` arguments via Node's `spawn()`, never interpolated into `sh -c` strings. Images are injected via `docker cp`, not shell pipes.
- **Credential separation** — User credentials are stored in a dedicated `credentials` field on sessions, never embedded in task descriptions. They are injected only at the point of execution and never appear in log output.
- **Encryption at rest** — Sensitive memory categories are encrypted with AES-256-GCM (key derived from `MEMORY_ENCRYPTION_KEY` via scrypt). Backward-compatible with legacy plaintext values.
- **Sub-agent API isolation** — Sub-agents access Rick's data via a read-only HTTP API authenticated with short-lived JWT tokens (HS256, random key per process). `MEMORY_ENCRYPTION_KEY` and `DATABASE_URL` never leave the main process — sub-agents receive only pre-decrypted values. Tokens expire with the container lifetime.
- **RBAC enforcement** — Role-based access control at the agent layer. Business users cannot trigger learning or sub-agents. Dev users cannot view secret values (sub-agents use them internally but never reveal values). Admin memories cannot be overwritten by dev users (hierarchy enforcement).
- **Web UI authentication** — WebSocket connection requires password verification before any data is exchanged. API endpoints require a token parameter. Web UI is admin-only.
- **Per-user message serialization** — A promise-chain queue prevents race conditions from concurrent messages mutating shared state.
- **User isolation** — Each user has isolated conversation history. Pending/blocked user messages are saved for admin visibility but never processed by the LLM.
- **LLM call timeouts** — All LLM providers (Gemini, Anthropic, OpenAI) have 5-minute timeouts with automatic retry on timeout before cascading to the next provider.
- **Automatic table pruning** — Conversation history and message logs are capped to prevent unbounded database growth.
- **Memory deletion protection** — Memories can only be deleted via the web UI settings panel, never through casual conversation patterns.

## Tech Stack

- **Runtime**: Node.js 22 + TypeScript (ESM)
- **WhatsApp**: Baileys v7 (unofficial WhatsApp Web API)
- **Web UI**: Vanilla HTML/CSS/JS (zero dependencies, single HTML file served by Express-less `http.createServer`)
- **WebSocket**: `ws` library for real-time Web UI communication
- **LLMs**: Gemini (Google AI SDK), Anthropic SDK, OpenAI SDK
- **Browser Automation**: Playwright (headless Chromium) inside sub-agent containers
- **Databases**: PostgreSQL 16 + pgvector (production), SQLite via `better-sqlite3` (fallback)
- **Embeddings**: Gemini Embedding 001 (768 dimensions)
- **Containers**: Docker + Docker Compose
- **Infrastructure**: Oracle Cloud Always Free (ARM A1.Flex + AMD Micro)
- **Auth**: OAuth 2.0 + PKCE (Claude, OpenAI)
