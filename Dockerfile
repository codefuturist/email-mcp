# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:24-slim AS builder

WORKDIR /app

# Enable pnpm via corepack (must match packageManager in package.json)
RUN corepack enable && corepack prepare pnpm@11.22.0 --activate

# Install dependencies (layer cached unless lock changes)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Build TypeScript
COPY tsconfig.json tsconfig.build.json ./
COPY src/ src/
RUN pnpm build

# Remove dev dependencies
RUN pnpm prune --prod

# ── Production stage ──────────────────────────────────────────────────────────
FROM node:24-slim AS production

LABEL org.opencontainers.image.title="email-mcp" \
      org.opencontainers.image.description="IMAP/SMTP email MCP server — 49 tools, stdio + Streamable HTTP, IMAP IDLE push, multi-account, AI triage" \
      org.opencontainers.image.url="https://github.com/codefuturist/email-mcp" \
      org.opencontainers.image.source="https://github.com/codefuturist/email-mcp" \
      org.opencontainers.image.licenses="LGPL-3.0-or-later" \
      org.opencontainers.image.vendor="codefuturist"

WORKDIR /app

# Copy only production artifacts
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Create config directory for volume mount
RUN mkdir -p /home/node/.config/email-mcp && chown -R node:node /home/node/.config

ENV NODE_ENV=production

# Streamable HTTP port (only used when running the `http` subcommand).
EXPOSE 8080

USER node

# Default: stdio. For HTTP, override the command, e.g.:
#   docker run -e EMAIL_MCP_HTTP_TOKEN=… -p 8080:8080 codefuturist/email-mcp \
#     http --host 0.0.0.0 --port 8080
ENTRYPOINT ["node", "dist/main.js"]
CMD ["stdio"]
