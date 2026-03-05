FROM subagent-base:chrome

USER root

# Copy agent entry point and shared modules only (fast rebuild path)
COPY --chown=agent:agent tools.mjs /app/tools.mjs
COPY --chown=agent:agent tool-declarations.mjs /app/tool-declarations.mjs
COPY --chown=agent:agent rick-api.mjs /app/rick-api.mjs
COPY --chown=agent:agent mcp-playwright.mjs /app/mcp-playwright.mjs
COPY --chown=agent:agent policy.mjs /app/policy.mjs
COPY --chown=agent:agent prompt.mjs /app/prompt.mjs
COPY --chown=agent:agent agent.mjs /app/agent.mjs

RUN chown -R agent:agent /app

USER agent
WORKDIR /workspace
