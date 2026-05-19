# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:24-slim AS builder

WORKDIR /app

RUN npm install -g pnpm@9.15.0 --ignore-scripts

# Install dependencies (layer cached unless lock changes)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts

# Build TypeScript
COPY tsconfig.json tsconfig.build.json ./
COPY src/ src/
RUN pnpm build

# Remove dev dependencies
RUN pnpm prune --prod --ignore-scripts

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

# Create config directory for volume mount
RUN mkdir -p /home/node/.config/email-mcp && chown -R node:node /home/node/.config

ENV NODE_ENV=production

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://localhost:8080/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"]

USER node

ENTRYPOINT ["node", "dist/main.js"]
CMD ["stdio"]
