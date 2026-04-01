# email-mcp — Claude Code Context

## Project Overview
Email MCP server (IMAP + SMTP) with 47+ tools, IMAP IDLE push, multi-account, AI triage.
Forked from `codefuturist/email-mcp` into `Swagatar-LLC/email-mcp` for security hardening.

## Tech Stack
- **Language:** TypeScript (strict mode)
- **Runtime:** Node.js 24+ (works on 22)
- **Package Manager:** pnpm 9.15.0
- **Build:** tsc (tsconfig.build.json)
- **Test:** Vitest (unit + integration with testcontainers)
- **Lint:** Biome + ESLint (airbnb-extended)
- **Hooks:** Lefthook (pre-commit, commit-msg, pre-push)
- **CI:** GitHub Actions (shared workflows from codefuturist org)
- **Docker:** Multi-stage build, non-root user

## Key Commands
```bash
pnpm test          # Unit tests (vitest)
pnpm typecheck     # TypeScript type checking
pnpm check         # Biome + ESLint
pnpm lint          # ESLint only
pnpm format        # Biome format
pnpm build         # TypeScript build
```

## Architecture
- `src/tools/` — MCP tool definitions (one file per tool group)
- `src/services/` — Business logic (IMAP, SMTP, OAuth, hooks, watcher, etc.)
- `src/safety/` — Audit logging, rate limiting, input validation
- `src/config/` — TOML config loading, Zod schemas, XDG paths
- `src/connections/` — IMAP/SMTP connection pooling
- `src/prompts/` — MCP prompt definitions
- `src/resources/` — MCP resource definitions

## Conventions
- Conventional commits (enforced by cog/lefthook)
- ESLint airbnb-extended + Biome formatting
- All tool inputs validated with Zod schemas
- Write tools gated behind `readOnly` config flag
- Audit logging for all write operations
