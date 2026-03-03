FROM node:22-slim

# Install system dependencies (git, curl for web fetch, Playwright deps)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Install Playwright browsers (used for web browsing tasks)
RUN npx playwright install chromium --with-deps 2>/dev/null || true

# Create non-root user
RUN useradd -m -u 1001 -s /bin/bash agent \
    && mkdir -p /app \
    && chown -R agent:agent /app

# Copy agent entry point and shared modules
COPY docker/tools.mjs /app/tools.mjs
COPY docker/tool-declarations.mjs /app/tool-declarations.mjs
COPY docker/rick-api.mjs /app/rick-api.mjs
COPY docker/agent.mjs /app/agent.mjs
RUN chown -R agent:agent /app

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

USER agent
WORKDIR /workspace
