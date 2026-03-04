# AGENTS.md

Instructions for AI agents contributing to this repository.

## Before you start

1. Read the project's `README.md` to understand its purpose, tech stack, endpoints, and directory structure.
2. Explore the current codebase to build context. Do not assume the README is accurate — the code is the source of truth.
3. If you find inconsistencies between the README and the code (removed endpoints still listed, outdated environment variables, incorrect directory structure, etc.), fix the README before proceeding with your task.

## During implementation

1. Implement the requested feature or fix.
2. Follow the coding style and patterns already established in the codebase.
3. Never commit credentials, tokens, or sensitive data. Check the `.gitignore` before staging any files.

## Cross-flow consistency (LLM / chat / UI)

This project has multiple parallel flows that share logic and must stay in sync. When modifying any of them, audit the others for consistency.

### LLM provider flows

| Flow | Files | Timeout constant |
|------|-------|-----------------|
| Main session (Gemini / Claude / OpenAI) | `src/llm/providers/*.ts` | `MAIN_LLM_TIMEOUT_MS` in `src/llm/types.ts` |
| Sub-agent sessions | `docker/agent.mjs` | `LLM_TIMEOUT_MS` in `docker/rick-api.mjs` |

**Rules:**
- Timeout values, retry logic, and cascade/fallback behavior must be consistent across all flows. If you change one, check the others.
- Sub-agent code lives in `docker/rick-api.mjs` (Rick API client, tool declarations, tool handler, timeout constants). Do not duplicate that logic.
- Command execution timeout (`COMMAND_TIMEOUT` in `docker/tools.mjs`) is intentionally separate from LLM timeouts.

### Viewer HTML pages

| Page | File | Purpose |
|------|------|---------|
| Web UI (main chat) | `src/connectors/web-ui.html` | Full interactive chat — primary UI |
| Main-session viewer | `src/connectors/main-session-viewer.html` | Public read+write view of the main session |
| Sub-agent viewer | `src/connectors/session-viewer.html` | View and interact with sub-agent sessions |

**Shared static assets** (in `src/connectors/static/`, served at `/static/`):
- `render-text.js` — markdown-to-HTML rendering (`renderText`), media rendering (`renderMessageContent`), image fullscreen, file/audio helpers. Used by both viewers.
- `tool-blocks.js` / `tool-blocks.css` — terminal-style tool-use blocks. Used by both viewers.

**Rules:**
- `session-viewer.html` and `main-session-viewer.html` must both use `/static/render-text.js` for text and media rendering. Do not inline `renderText` or `renderMessageContent` in those files.
- `web-ui.html` has its own inline `renderText` and `renderMessageContent` with extra features (audio transcription animation). These are intentionally separate. If you change the shared `render-text.js`, check whether `web-ui.html` needs the same change.
- Media rendering (images, audio players, file cards) must be present in all three viewers. If you add a new media type, add it to `render-text.js` and `web-ui.html`.
- CSS for markdown elements (headings, lists, hr, code-lang, pre code) and media elements (image-message, audio-message, file-attachment) must be present in all viewer `<style>` blocks.

### Checklist (run mentally before committing)

1. Did I change an LLM timeout, retry, or cascade? → Check both provider flows.
2. Did I change `renderText` or `renderMessageContent`? → Check `render-text.js` AND `web-ui.html`.
3. Did I add a new media type or message field? → Update `render-text.js`, `web-ui.html`, and the `appendMessage`/`appendHistoryMessage` functions in both viewers.
4. Did I change tool declarations or tool handlers in `docker/`? → Ensure `rick-api.mjs` is the single source; do not duplicate in `agent.mjs`.
5. Did I add a new shared static file? → Verify the filename matches the whitelist regex `^[\w-]+\.(css|js)$` in `src/health.ts`.

## After implementation

1. Run all repository tests, if configured, and ensure every test passes. If any test fails, fix it before proceeding.
2. Run `npx tsc --noEmit` to verify TypeScript compiles. Run `node --check` on any modified `.mjs` files.
3. Update the README to reflect your changes when applicable:
   - Add new endpoints or routes to the corresponding tables.
   - Document new environment variables (without real values).
   - Update the directory tree if the project structure changed.
   - Document new service communication points (Feign clients, RabbitMQ queues, events).
4. Remove from the README any references to features that no longer exist. The README must always reflect the current state of the project.
5. Review the `.gitignore` and verify that staged files contain only changes related to the requested implementation or fix.
