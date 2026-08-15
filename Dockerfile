# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:24-slim AS builder

WORKDIR /app

RUN npm install -g pnpm@9.15.0 --ignore-scripts

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
      org.opencontainers.image.description="IMAP/SMTP email MCP server — 47 tools, IMAP IDLE push, multi-account, AI triage" \
      org.opencontainers.image.url="https://github.com/codefuturist/email-mcp" \
      org.opencontainers.image.source="https://github.com/codefuturist/email-mcp" \
      org.opencontainers.image.licenses="LGPL-3.0-or-later" \
      org.opencontainers.image.vendor="codefuturist"

WORKDIR /app

# Copy only production artifacts
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Create config directory for volume mount and default attachment download path
RUN mkdir -p /home/node/.config/email-mcp /workspace/paperless \
  && chown -R node:node /home/node/.config /workspace/paperless

ENV NODE_ENV=production
# Optional default; override with MCP_EMAIL_ATTACHMENT_DOWNLOAD_DIR at runtime
ENV MCP_EMAIL_ATTACHMENT_DOWNLOAD_DIR=/workspace/paperless

USER node

ENTRYPOINT ["node", "dist/main.js"]
CMD ["stdio"]
