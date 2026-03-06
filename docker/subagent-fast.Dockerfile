FROM subagent-base:chrome

# Fast rebuild path: refresh runtime deps + copy bridge/runtime files.
# Run npm install as agent (base image already owns /app as agent:agent)
# to avoid costly chown -R on node_modules over slow overlay+HDD.
COPY --chown=agent:agent subagent.package.json /app/package.json
USER agent
RUN cd /app && npm install --omit=dev
USER root

COPY --chown=agent:agent AGENTS.md /app/AGENTS.md
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
