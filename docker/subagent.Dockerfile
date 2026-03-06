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
# Run npm install as agent (owns /app) to avoid costly chown -R on node_modules.
COPY --chown=agent:agent subagent.package.json /app/package.json
USER agent
RUN cd /app && npm install --omit=dev
USER root

# Install Playwright browsers (used for web browsing tasks)
# Must run after setting PLAYWRIGHT_BROWSERS_PATH so runtime and install path match.
# Chrome (not Chromium) for better site compatibility with SPAs, iframes, etc.
# Runs as root because --with-deps installs system packages via apt.
RUN cd /app && npx playwright install chrome --with-deps
RUN chmod -R a+rX /ms-playwright

# Copy all runtime files in a single layer to minimise overlay depth.
COPY --chown=agent:agent AGENTS.md tools.mjs tool-declarations.mjs \
     rick-api.mjs mcp-playwright.mjs rick-mcp.mjs opencode.json \
     policy.mjs prompt.mjs agent.mjs /app/

USER agent
WORKDIR /workspace
