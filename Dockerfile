FROM node:22-slim

# Install system dependencies:
#   - git, curl, ca-certificates, gnupg: for Docker CLI and general tooling
#   - python3, make, g++: for native modules (better-sqlite3 — still needed for transition period)
#   - postgresql, postgresql-*-pgvector: embedded PostgreSQL with vector support
#   - sqlite3: for the one-time SQLite → PostgreSQL migration
#   - procps: for entrypoint process management
RUN apt-get update && \
    apt-get install -y git curl ca-certificates gnupg python3 make g++ procps sqlite3 && \
    # Docker CLI
    install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
    chmod a+r /etc/apt/keyrings/docker.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list && \
    apt-get update && \
    apt-get install -y docker-ce-cli && \
    # PostgreSQL (from PGDG repo for latest version + pgvector)
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /etc/apt/trusted.gpg.d/pgdg.gpg && \
    echo "deb http://apt.postgresql.org/pub/repos/apt $(. /etc/os-release && echo "$VERSION_CODENAME")-pgdg main" > /etc/apt/sources.list.d/pgdg.list && \
    apt-get update && \
    apt-get install -y postgresql-16 postgresql-16-pgvector && \
    rm -rf /var/lib/apt/lists/*

# Add PostgreSQL binaries to PATH (installed in /usr/lib/postgresql/16/bin/)
ENV PATH="/usr/lib/postgresql/16/bin:$PATH"

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm install --production=false

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/

# Build
RUN npm run build

# Copy non-TS assets into dist (tsc only compiles .ts files)
RUN cp src/connectors/web-ui.html dist/connectors/web-ui.html
RUN cp src/connectors/session-viewer.html dist/connectors/session-viewer.html
RUN cp src/connectors/sessions-list.html dist/connectors/sessions-list.html
RUN cp src/connectors/main-session-viewer.html dist/connectors/main-session-viewer.html
RUN cp src/connectors/webhooks.html dist/connectors/webhooks.html 2>/dev/null || true
RUN cp src/connectors/schedules.html dist/connectors/schedules.html 2>/dev/null || true
RUN cp -r src/connectors/static dist/connectors/static

# Cleanup dev deps
RUN npm prune --production

# Create required directories
RUN mkdir -p auth_info data

# Copy entrypoint script and fix line endings (Windows → Unix)
COPY scripts/entrypoint.sh /app/scripts/entrypoint.sh
RUN sed -i 's/\r$//' /app/scripts/entrypoint.sh && chmod +x /app/scripts/entrypoint.sh

# Version info (injected at build time via --build-arg)
ARG COMMIT_SHA=unknown
ARG COMMIT_DATE=unknown
ENV RICK_COMMIT_SHA=$COMMIT_SHA
ENV RICK_COMMIT_DATE=$COMMIT_DATE

# Copy .rick-version into the image as a fallback version source.
COPY .rick-version* ./

EXPOSE 80

# Use the entrypoint script that manages embedded PostgreSQL.
# Override the base node image's ENTRYPOINT which would prepend "node" to .sh files.
ENTRYPOINT ["/bin/bash"]
CMD ["/app/scripts/entrypoint.sh"]
