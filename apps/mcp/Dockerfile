FROM oven/bun:1-alpine

WORKDIR /app

# Build with the repository root as Docker context:
#   docker build -f apps/mcp/Dockerfile .
#
# The MCP app depends on the monorepo workspace package @slashtalk/shared, so
# the old single-package COPY layout no longer works from apps/mcp as context.
COPY package.json bun.lock ./
COPY apps/desktop/package.json ./apps/desktop/package.json
COPY apps/mcp/package.json ./apps/mcp/package.json
COPY apps/server/package.json ./apps/server/package.json
COPY packages/shared/package.json ./packages/shared/package.json
RUN bun install --frozen-lockfile --production

COPY apps/mcp ./apps/mcp
COPY packages/shared ./packages/shared

WORKDIR /app/apps/mcp

CMD ["bun", "src/index.ts"]
