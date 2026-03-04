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

# Copy agent entry point and shared modules
COPY docker/tools.mjs /app/tools.mjs
COPY docker/tool-declarations.mjs /app/tool-declarations.mjs
COPY docker/rick-api.mjs /app/rick-api.mjs
COPY docker/browser-agent.mjs /app/browser-agent.mjs
COPY docker/agent.mjs /app/agent.mjs
RUN cd /app && npm init -y && npm install playwright@1.55.0 --omit=dev

# Install Playwright browsers (used for web browsing tasks)
# Must run after setting PLAYWRIGHT_BROWSERS_PATH so runtime and install path match.
RUN cd /app && npx playwright install chromium --with-deps

RUN chmod -R a+rX /ms-playwright
RUN chown -R agent:agent /app

USER agent
WORKDIR /workspace
