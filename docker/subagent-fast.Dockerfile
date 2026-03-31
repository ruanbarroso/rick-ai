FROM subagent-base:chrome

# Fast rebuild path: refresh runtime deps + copy bridge/runtime files.
# Run npm install as agent (base image already owns /app as agent:agent)
# to avoid costly chown -R on node_modules over slow overlay+HDD.
COPY --chown=agent:agent subagent.package.json /app/package.json
USER agent
RUN cd /app && npm install --omit=dev
USER root

# Install opencode-claude-auth plugin (replicates ~/.config/opencode/ structure)
COPY --chown=agent:agent opencode-plugins/package.json /home/agent/.config/opencode/package.json
COPY --chown=agent:agent opencode-plugins/plugins/claude-auth.js /home/agent/.config/opencode/plugins/claude-auth.js
USER agent
RUN cd /home/agent/.config/opencode && npm install --omit=dev
USER root

# Copy all runtime files in a single layer to minimise overlay depth.
COPY --chown=agent:agent AGENTS.md tools.mjs tool-declarations.mjs \
     rick-api.mjs mcp-playwright.mjs rick-mcp.mjs opencode.json \
     policy.mjs prompt.mjs agent.mjs stream-bridge.mjs /app/

USER agent
WORKDIR /workspace

CMD ["node", "/app/agent.mjs"]
