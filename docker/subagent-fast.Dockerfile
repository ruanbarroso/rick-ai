FROM subagent-base:chrome

USER root

# Fast rebuild path: refresh runtime deps + copy bridge/runtime files.
COPY subagent.package.json /app/package.json
RUN cd /app && npm install --omit=dev

COPY --chown=agent:agent tools.mjs /app/tools.mjs
COPY --chown=agent:agent tool-declarations.mjs /app/tool-declarations.mjs
COPY --chown=agent:agent rick-api.mjs /app/rick-api.mjs
COPY --chown=agent:agent mcp-playwright.mjs /app/mcp-playwright.mjs
COPY --chown=agent:agent rick-mcp.mjs /app/rick-mcp.mjs
COPY --chown=agent:agent opencode.json /app/opencode.json
COPY --chown=agent:agent policy.mjs /app/policy.mjs
COPY --chown=agent:agent prompt.mjs /app/prompt.mjs
COPY --chown=agent:agent agent.mjs /app/agent.mjs

RUN chown -R agent:agent /app

USER agent
WORKDIR /workspace
