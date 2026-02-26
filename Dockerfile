FROM node:22-slim

# Install git + Docker CLI + build tools for native modules (better-sqlite3)
RUN apt-get update && \
    apt-get install -y git curl ca-certificates gnupg python3 make g++ && \
    install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
    chmod a+r /etc/apt/keyrings/docker.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list && \
    apt-get update && \
    apt-get install -y docker-ce-cli && \
    rm -rf /var/lib/apt/lists/*

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

# Cleanup dev deps
RUN npm prune --production

# Create auth dir + data dir (for SQLite DB when no PostgreSQL)
RUN mkdir -p auth_info data

# Version info (injected at build time via --build-arg)
ARG COMMIT_SHA=unknown
ARG COMMIT_DATE=unknown
ENV RICK_COMMIT_SHA=$COMMIT_SHA
ENV RICK_COMMIT_DATE=$COMMIT_DATE

EXPOSE 80

CMD ["node", "dist/index.js"]
