FROM node:22-slim

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Install system dependencies (git, curl for web fetch, Playwright deps)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN useradd -m -u 1001 -s /bin/bash agent \
    && mkdir -p /app /ms-playwright \
    && chown -R agent:agent /app /ms-playwright

# Install runtime deps in a cache-friendly layer.
# Keep this before copying frequently changed agent source files.
COPY docker/subagent.package.json /app/package.json
RUN cd /app && npm install --omit=dev

# Install Playwright browsers (used for web browsing tasks)
# Must run after setting PLAYWRIGHT_BROWSERS_PATH so runtime and install path match.
RUN cd /app && npx playwright install chromium --with-deps

# Copy agent entry point and shared modules
COPY docker/tools.mjs /app/tools.mjs
COPY docker/tool-declarations.mjs /app/tool-declarations.mjs
COPY docker/rick-api.mjs /app/rick-api.mjs
COPY docker/mcp-playwright.mjs /app/mcp-playwright.mjs
COPY docker/agent.mjs /app/agent.mjs

RUN chmod -R a+rX /ms-playwright
RUN chown -R agent:agent /app

USER agent
WORKDIR /workspace
