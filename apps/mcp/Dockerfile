FROM oven/bun:1-alpine

WORKDIR /app

# Render builds this service with apps/mcp as the Docker context. Keep the
# container manifest self-contained: @slashtalk/shared is only used by type-only
# imports in this service, so runtime install does not need the workspace.
COPY package.docker.json ./package.json
RUN bun install --production

COPY src ./src
COPY migrations ./migrations
COPY tsconfig.json ./

CMD ["bun", "src/index.ts"]
