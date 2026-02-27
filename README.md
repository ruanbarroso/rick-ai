# Rick — Personal AI Agent on WhatsApp & Web

Rick is a personal AI assistant that runs on WhatsApp and a Web UI. You message yourself (or open the web interface), and Rick answers — with persistent memory, multi-LLM routing, autonomous sub-agents, browser automation, self-editing, and zero server cost.

Built on Oracle Cloud Always Free VMs, Rick orchestrates multiple LLM providers and spawns isolated Docker containers with a unified sub-agent that can browse the web, run shell commands, read/write files, and query databases.

## Architecture

```
 WhatsApp (self-chat)       Web UI (rick.barroso.tec.br)
        │                            │
   WhatsApp Connector          Web Connector
        │                      (WebSocket)
        └──────────┬─────────────┘
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
 SessionManager  OAuth                  │
     │        (Claude/GPT)              │
     ▼                                  │
  Unified Sub-Agent Container           │
  (Claude→GPT→Gemini Pro→Flash)         │
  (Browser + Shell + Files + DB)        │
```

### How a message flows

1. **Connector** (WhatsApp or Web) receives a message, wraps it as an `IncomingMessage`, and passes it to the **ConnectorManager**
2. **Agent.handleMessage()** serializes per user (message queue prevents race conditions) and routes it:
   - `/commands` → slash command handler
   - Edit mode active → Claude Code container
   - Audio → transcribed to text via Gemini, then routed normally
   - Active sub-agent session → relay (continuation, close, or nag)
   - Otherwise → **Classifier** decides: `SELF` (direct chat) or `DELEGATE` (sub-agent)
3. For `SELF`: Gemini Flash responds with conversation history + memory context
4. For `DELEGATE`: a unified Docker container is spawned with all LLM providers, credentials injected, output streamed back via the originating connector

## Features

### Multi-Connector Architecture

Rick supports multiple messaging platforms through a connector abstraction:

| Connector | Features |
|-----------|----------|
| **WhatsApp** | Self-chat via Baileys v7, polls, audio/image media, typing indicators |
| **Web UI** | Password-protected WebSocket chat, audio recording, image upload, settings panel, session viewer, OAuth flows, QR code display |

Connectors are managed by the `ConnectorManager`, which routes messages bidirectionally between connectors and the Agent core. New connectors (Discord, Telegram, etc.) can be added by implementing the `Connector` interface.

### Multi-LLM Routing

| Model | Provider | Used For |
|-------|----------|----------|
| Gemini 3 Flash Preview | Google | Default chat, classifier, audio transcription, memory extraction |
| Claude Opus 4.6 | Anthropic | Sub-agent primary (via OAuth), edit mode |
| GPT-5.3 Codex | OpenAI | Sub-agent fallback (via OAuth) |
| Gemini 3.1 Pro Preview | Google | Sub-agent fallback |
| Gemini 3 Flash Preview | Google | Sub-agent last resort |

No API keys needed for Claude or GPT — Rick uses OAuth 2.0 + PKCE to connect via your existing Pro/Max subscriptions. API key fallback models (`claude-opus-4-6`, `gpt-5.3-codex`) are used when OAuth is not configured.

### Persistent Memory

Rick has two memory systems working together:

- **Structured memory** (PostgreSQL or SQLite) — key-value pairs organized by category (credentials, personal info, notes, preferences). Supports exact match, Portuguese full-text search, and ILIKE fallback.
- **Semantic memory** (pgvector) — conversation embeddings via Gemini's embedding model (768 dimensions, HNSW index). Enables "search by meaning" for past conversations.

Memories are extracted automatically:
- Regex patterns catch simple cases ("meu nome e Joao", "minha senha do github e...")
- LLM extraction (Gemini Flash) handles complex cases when the assistant confirms saving something
- Every non-trivial conversation is embedded into vector memory

Credential memories are protected: partial extractions cannot overwrite richer existing values (smart merge).

Credentials in sensitive categories (`senhas`, `credenciais`, `tokens`, `passwords`, `secrets`) are **encrypted at rest** with AES-256-GCM. The encryption key is derived from `MEMORY_ENCRYPTION_KEY` via scrypt. Encrypted values are stored as `enc:iv:authTag:ciphertext` and decrypted transparently on read. Legacy plaintext values are handled gracefully (backward-compatible).

Tables are automatically pruned to prevent unbounded growth:
- `conversations`: capped at 500 messages per user
- `message_log`: capped at 5000 entries globally

**SQLite fallback**: When `DATABASE_URL` is not set, Rick automatically uses SQLite for structured memory, so PostgreSQL is not strictly required for development/testing.

### Unified Sub-Agent

All delegated tasks (coding, research, browser automation) are handled by a **single unified sub-agent** container with:

- **LLM cascade**: Claude Opus 4.6 → GPT-5.3 Codex → Gemini 3.1 Pro → Gemini Flash (automatic failover on rate limits or errors)
- **Tools**: Browser (Playwright + headless Chromium), shell commands, file I/O, HTTP fetch, read-only PostgreSQL access
- **NDJSON protocol**: stdin/stdout communication with the main Rick process for real-time streaming
- **Context rotation**: Automatic summarization when context window fills up
- **Credential injection**: OAuth tokens and stored passwords injected at runtime (never in task descriptions). Sensitive memories are pre-resolved and injected as `RICK_SECRET_*` env vars (decrypted, no encryption key exposed).
- **Agent API access**: Each sub-agent receives a signed JWT (`RICK_SESSION_TOKEN`) and API URL (`RICK_API_URL`) to query Rick's read-only API for memories, credentials, semantic search, conversations, and config — all scoped to the owner's data.
- **Session recovery**: Running containers are recovered after Rick restarts

Each sub-agent gets a unique Rick variant name (Rick Prime, Pickle Rick, Evil Rick, etc.) for easy identification.

### Self-Editing (`/edit` mode)

Rick can edit his own source code:

1. `/edit` — Starts an edit session. Creates a staging copy of `src/`, launches the `subagent-edit` container (auto-built on first run). Provider priority: **Claude Code → GPT-5.3 Codex → Gemini 3.1 Pro**, chosen automatically based on which credentials are available.
2. Send prompts describing what to change — the active provider edits the files directly inside the isolated container.
3. `/deploy` — Triggers the deploy pipeline:
   - Backup current `src/` → build candidate image → smoke test (health-only mode) → swap containers → 60s watchdog → rollback on failure
4. `/publish [usuario/repo]` — Deploy + push code to GitHub. Defaults to `ruanbarroso/rick-ai`. Resolves GitHub token from Rick's memories, validates write access, runs the full deploy pipeline, then pushes. Push strategy: fast-forward → rebase → `--force-with-lease`.
5. `/exit` — Exits edit mode without deploying.

### Web UI

The Web UI (`https://rick.barroso.tec.br`) provides a full browser-based interface:

- **Chat**: Send text, record audio (transcribed via Gemini), upload images (single or multi-image)
- **Sub-agent sessions**: View active sessions, send follow-up messages, kill sessions, view session history
- **Public session viewer**: Shareable link (`/s/:sessionId`) for real-time sub-agent output
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

### Commands

| Command | Description |
|---------|-------------|
| `/edit` | Start edit mode (Claude Code on Rick's own source) |
| `/exit` | Exit edit mode without deploying |
| `/deploy` | Deploy staged changes (build + smoke test + swap + watchdog) |
| `/publish [user/repo]` | Deploy + push to GitHub (default: `ruanbarroso/rick-ai`) |
| `/status` | Show active sessions, memory stats, connected providers |
| `/help` or `/ajuda` | Show all available commands |
| `/modelo` | Show configured models and OAuth connection status |
| `/conectar claude` | Start Claude OAuth flow |
| `/conectar gpt` | Start GPT OAuth flow (alias: `/conectar openai`) |
| `/desconectar claude` | Disconnect Claude |
| `/desconectar gpt` | Disconnect GPT (alias: `/desconectar openai`) |
| `/lembrar [cat:]key = value` | Save a memory |
| `/esquecer key` | Delete a memory |
| `/esquecer_tudo` | Delete ALL memories |
| `/memorias [category]` | List memories |
| `/buscar <term>` | Search structured memories by term |
| `/vsearch <query>` or `/vbuscar <query>` | Semantic (vector) memory search |
| `/limpar` | Clear conversation history |
| `/matar` or `/kill` | Kill all active sub-agents |

### HTTP Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | None | Health check (JSON: status, uptime, WhatsApp/Postgres/pgvector) |
| `/` | GET | None | Web UI (single HTML page) |
| `/s/:sessionId` | GET | None | Public sub-agent session viewer |
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
| `ws://host/ws` | Password | Authenticated Web UI real-time chat + settings |
| `ws://host/ws/session?id=<id>` | None | Public session viewer real-time messages |

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
│   │   └── session-viewer.html        # Public sub-agent session viewer page
│   ├── llm/
│   │   ├── llm-service.ts             # Provider abstraction + model switching
│   │   ├── types.ts                   # Model registry + shared types
│   │   └── providers/
│   │       ├── gemini.ts              # Gemini (multimodal)
│   │       ├── anthropic.ts           # Anthropic (API key + OAuth)
│   │       └── openai.ts             # OpenAI (API key + Codex OAuth)
│   ├── auth/
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
│   └── edit-agent.mjs                 # Entry point: routes to Claude CLI / OpenAI / Gemini API
│   └── subagent-research/             # Legacy research sub-agent
│       ├── Dockerfile
│       └── research.mjs
├── scripts/
│   └── deploy.sh                      # Safe deploy pipeline (backup → build → smoke → swap → watchdog)
├── Dockerfile                         # Main agent image (Node.js 22 + Docker CLI)
├── docker-compose.yml                 # Agent service definition
├── deploy-db.sh                       # PostgreSQL deploy on Oracle Cloud
├── setup-oracle.sh                    # Oracle Cloud VM initial setup
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
└── subagent-edit-*                # Ephemeral, created per /edit session
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
| `AGENT_NAME` | No | `Jarvis` | Agent display name |
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
users (id, phone, name, is_owner, created_at, updated_at)
memories (id, user_phone, category, key, value, metadata, created_at, updated_at)
  -- UNIQUE (user_phone, category, key)
  -- GIN index on to_tsvector('portuguese', key || ' ' || value)
conversations (id, user_phone, role, content, model_used, tokens_used, created_at)
message_log (id, wa_message_id, author, content, created_at)
oauth_tokens (id, user_phone, provider, access_token, refresh_token, expires_at, ...)
audio_blobs (id, data BYTEA, mime_type, created_at)
  -- Stores both audio and image binary data
session_messages (id, session_id, role, content, created_at)
  -- Sub-agent conversation history for session viewer
config_store (key, value, updated_at)
  -- Runtime config persistence (API keys, settings from Web UI)
```

### Vector DB

```sql
memory_embeddings (id, user_phone, content, category, source, embedding vector(768),
                   metadata, hit_count, last_hit_at, created_at)
  -- HNSW index (m=16, ef_construction=64, cosine distance)
```

## Deploy Pipeline

The deploy pipeline (`scripts/deploy.sh`) ensures safe self-editing:

```
1. Backup current src/ → src.bak/
2. Copy staged files from edit session
3. Build candidate Docker image (TypeScript errors = fail)
4. Start candidate in HEALTH_ONLY mode on port 8081
5. Health check (20 attempts, 3s apart)
6. If healthy → re-tag candidate as main image, docker compose up -d (no rebuild)
7. Watchdog: monitor health for 60s (12 checks, 5s apart)
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

# 2. Deploy PostgreSQL (optional — uses Oracle Cloud VM)
./deploy-db.sh

# 3. Build and start
docker compose up -d --build

# 4. Pair WhatsApp
docker compose logs -f agent
# Scan the QR code with WhatsApp (Linked Devices)

# 5. Message yourself on WhatsApp or open the Web UI
# Rick will respond to your self-chat messages
# Web UI available at http://localhost:80 (requires WEB_AUTH_PASSWORD)
```

## Security

- **No shell injection** — Sub-agent prompts are passed as direct `execve()` arguments via Node's `spawn()`, never interpolated into `sh -c` strings. Images are injected via `docker cp`, not shell pipes.
- **Credential separation** — User credentials are stored in a dedicated `credentials` field on sessions, never embedded in task descriptions. They are injected only at the point of execution and never appear in log output.
- **Encryption at rest** — Sensitive memory categories are encrypted with AES-256-GCM (key derived from `MEMORY_ENCRYPTION_KEY` via scrypt). Backward-compatible with legacy plaintext values.
- **Sub-agent API isolation** — Sub-agents access Rick's data via a read-only HTTP API authenticated with short-lived JWT tokens (HS256, random key per process). `MEMORY_ENCRYPTION_KEY` and `DATABASE_URL` never leave the main process — sub-agents receive only pre-decrypted values. Tokens expire with the container lifetime.
- **Web UI authentication** — WebSocket connection requires password verification before any data is exchanged. API endpoints require a token parameter.
- **Per-user message serialization** — A promise-chain queue prevents race conditions from concurrent messages mutating shared state.
- **LLM call timeouts** — All LLM providers (Gemini, Anthropic, OpenAI) have 60-second timeouts to prevent indefinite hangs.
- **Automatic table pruning** — Conversation history and message logs are capped to prevent unbounded database growth.
- **Memory deletion protection** — Memories can only be deleted via the explicit `/esquecer` command, never through casual conversation patterns.

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
