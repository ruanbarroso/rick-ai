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
COPY subagent.package.json /app/package.json
RUN cd /app && npm install --omit=dev

# Install Playwright browsers (used for web browsing tasks)
# Must run after setting PLAYWRIGHT_BROWSERS_PATH so runtime and install path match.
# Chrome (not Chromium) for better site compatibility with SPAs, iframes, etc.
RUN cd /app && npx playwright install chrome --with-deps

# Fix ownership of npm-installed files (created as root)
RUN chown -R agent:agent /app/package.json /app/package-lock.json /app/node_modules 2>/dev/null; true
RUN chmod -R a+rX /ms-playwright

# Copy agent entry point and shared modules
COPY --chown=agent:agent tools.mjs /app/tools.mjs
COPY --chown=agent:agent tool-declarations.mjs /app/tool-declarations.mjs
COPY --chown=agent:agent rick-api.mjs /app/rick-api.mjs
COPY --chown=agent:agent mcp-playwright.mjs /app/mcp-playwright.mjs
COPY --chown=agent:agent rick-mcp.mjs /app/rick-mcp.mjs
COPY --chown=agent:agent opencode.json /app/opencode.json
COPY --chown=agent:agent policy.mjs /app/policy.mjs
COPY --chown=agent:agent prompt.mjs /app/prompt.mjs
COPY --chown=agent:agent agent.mjs /app/agent.mjs

USER agent
WORKDIR /workspace
