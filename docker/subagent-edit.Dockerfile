FROM node:22-slim

# Install system dependencies (git for Claude Code, curl for health checks)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally (used when CLAUDE_CODE_OAUTH_TOKEN is set)
RUN npm install -g @anthropic-ai/claude-code

# Install Playwright browsers (used by Claude Code for web tasks)
RUN npx playwright install chromium --with-deps 2>/dev/null || true

# Create non-root user matching host UID 1001
RUN useradd -m -u 1001 -s /bin/bash claude \
    && mkdir -p /home/claude/.claude \
    && chown -R claude:claude /home/claude/.claude

# Copy edit agent entry point and shared modules
COPY docker/tools.mjs /app/tools.mjs
COPY docker/tool-declarations.mjs /app/tool-declarations.mjs
COPY docker/rick-api.mjs /app/rick-api.mjs
COPY docker/edit-agent.mjs /app/edit-agent.mjs
RUN chown -R claude:claude /app

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

USER claude
WORKDIR /workspace
