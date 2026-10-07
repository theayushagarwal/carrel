# Multi-stage Dockerfile for Carrel single-service deployment
FROM node:20-slim AS builder

WORKDIR /app

# Install native compilation dependencies for better-sqlite3
RUN apt-get update && apt-get install -y python3 make g++ --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Copy package manifests across workspaces
COPY package*.json ./
COPY shared/package*.json ./shared/
COPY server/package*.json ./server/
COPY client/package*.json ./client/

# Install full dependencies including devDependencies for build
RUN npm ci

# Copy entire source tree
COPY . .

# Build all packages in order: shared -> client -> server
RUN npm run build

# --- Production Runner Stage ---
FROM node:20-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV DATABASE_PATH=/data/carrel.db

# Install compilation tools and curl for healthcheck
RUN apt-get update && apt-get install -y python3 make g++ curl --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Copy workspace package manifests
COPY package*.json ./
COPY shared/package*.json ./shared/
COPY server/package*.json ./server/
COPY client/package*.json ./client/

# Install only production dependencies (compiling better-sqlite3 for linux), then purge build tools
RUN npm ci --omit=dev \
    && apt-get purge -y python3 make g++ \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# Copy built artifacts from builder stage
COPY --from=builder /app/shared/dist ./shared/dist
COPY --from=builder /app/client/dist ./client/dist
COPY --from=builder /app/server/dist ./server/dist

# Ensure persistent database directory exists and grant permissions to non-root node user
RUN mkdir -p /data && chown -R node:node /data /app

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -f http://127.0.0.1:${PORT}/api/health || exit 1

CMD ["node", "server/dist/index.js"]
