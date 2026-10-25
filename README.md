# Email MCP Server

[![standard-readme compliant](https://img.shields.io/badge/readme%20style-standard-brightgreen.svg?style=flat-square)](https://github.com/RichardLitt/standard-readme)
[![license](https://img.shields.io/github/license/codefuturist/email-mcp.svg?style=flat-square)](LICENSE)
[![npm version](https://img.shields.io/npm/v/@codefuturist/email-mcp.svg?style=flat-square)](https://www.npmjs.com/package/@codefuturist/email-mcp)
[![npm downloads](https://img.shields.io/npm/dm/@codefuturist/email-mcp.svg?style=flat-square)](https://www.npmjs.com/package/@codefuturist/email-mcp)
[![CI](https://img.shields.io/github/actions/workflow/status/codefuturist/email-mcp/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/codefuturist/email-mcp/actions/workflows/ci.yml)

An MCP (Model Context Protocol) server providing comprehensive email capabilities via IMAP and SMTP.

Enables AI assistants to read, search, send, manage, schedule, and analyze emails across multiple accounts. Exposes 52 tools, 7 prompts, and 6 resources over the MCP protocol with OAuth2 support _(experimental)_, email scheduling, calendar extraction, analytics, provider-aware label management, real-time IMAP IDLE watcher with AI-powered triage, instant verification-code catching with clipboard copy, customizable presets and static rules, and a guided setup wizard.

Built on the MCP TypeScript SDK v2 (spec revision 2026-07-28), it serves over **stdio** for local clients or **Streamable HTTP** for networked access — existing stdio configurations keep working unchanged.

## Highlights

| Feature | email-mcp | Typical MCP email |
|---------|:---------:|:-----------------:|
| Multi-account | ✅ | ❌ |
| Send / reply / forward | ✅ | ✅ |
| Drafts & templates | ✅ | ❌ |
| Labels & bulk ops | ✅ provider-aware | ❌ |
| Schedule future emails | ✅ | ❌ |
| Real-time IMAP IDLE watcher | ✅ | ❌ |
| Verification codes → clipboard | ✅ concealed + auto-clear | ❌ |
| AI triage with presets | ✅ | ❌ |
| Desktop & webhook alerts | ✅ | ❌ |
| Calendar (ICS) extraction | ✅ | ❌ |
| Email analytics | ✅ | ❌ |
| OAuth2 (Gmail / M365) | ✅ _experimental_ | ❌ |
| Guided setup wizard | ✅ auto-detect | ❌ |
| Streamable HTTP transport | ✅ | ❌ |

## Table of Contents

- [Highlights](#highlights)
- [Security](#security)
- [Background](#background)
- [Install](#install)
- [Usage](#usage)
- [API](#api)
- [Roadmap](#roadmap)
- [Maintainers](#maintainers)
- [Contributing](#contributing)
- [License](#license)

## Security

- All connections use TLS/STARTTLS encryption
- Passwords are never logged; audit trail records operations without credentials
- Token-bucket rate limiter prevents abuse (one bucket per account, sharing a global `rate_limit`)
- OAuth2 XOAUTH2 authentication for Gmail and Microsoft 365 _(experimental)_
- Attachment downloads capped at 5 MB with base64 encoding

## Background

Most MCP email implementations provide only basic read/send. This server aims to be a full-featured email client for AI assistants, covering the entire lifecycle: reading, composing, managing, scheduling, and analyzing email — all from a single MCP server.

Key design decisions:

- **XDG-compliant config** — TOML at `~/.config/email-mcp/config.toml`
- **Multi-account** — Operate across multiple IMAP/SMTP accounts simultaneously
- **Layered services** — Business logic is decoupled from MCP wiring for testability
- **Provider auto-detection** — Gmail, Outlook, Yahoo, iCloud, Fastmail, ProtonMail, Zoho, GMX

## Install

Requires Node.js ≥ 24.

```bash
# Run directly (no install needed)
npx @codefuturist/email-mcp setup
# or
pnpm dlx @codefuturist/email-mcp setup

# Or install globally
npm install -g @codefuturist/email-mcp
# or
pnpm add -g @codefuturist/email-mcp
```

`npm install -g` fails with `EACCES` when npm's global prefix is a root-owned
directory (common on a system Node install) — the `npx`/`pnpm dlx` form above
avoids this entirely by not installing anything globally. If you do want a
permanent global install, fix npm's prefix instead of reaching for `sudo`
(`npm config set prefix ~/.npm-global` and add that to `PATH`, or use a Node
version manager like `nvm`/`fnm`/`volta`) — running `npm install -g` as root
routinely leaves root-owned files mixed into a user-owned `node_modules` tree,
which causes harder-to-diagnose permission errors on the *next* global install.

### Homebrew (native binary)

The prebuilt, dependency-free binary — no Node.js at runtime — from the
[codefuturist tap](https://github.com/codefuturist/homebrew-tap):

```bash
brew install codefuturist/tap/email-mcp
```

Published as a cask on every stable release; works on macOS (arm64 + x64) and
on Linuxbrew ≥ 4.3 (binary-only casks).

### Native binary (Bun)

A dependency-free single binary (minified + bytecode-precompiled, ~32 ms cold
start, no Node.js at runtime) can be compiled with [Bun](https://bun.sh):

```bash
bun run build:binary          # native binary → build/email-mcp
cp build/email-mcp ~/.local/bin/

bun run build:binaries        # release matrix: darwin-arm64/x64, linux-x64/arm64,
                              # windows-x64 → build/release/*.{tar.gz,zip} + sha256 checksums
```

Prebuilt binaries for every release are built by CI with GoReleaser Pro
(`.goreleaser.yaml`) for all common platforms — Linux glibc + musl, macOS, and
Windows, each x64 + arm64 where Bun supports it — provenance-attested (verify with
`gh attestation verify <asset> --repo codefuturist/email-mcp`) and shipped with
[GitHub releases](https://github.com/codefuturist/email-mcp/releases) —
installable via mise: `mise use -g ubi:codefuturist/email-mcp`.

The same binary can also be built locally from the published npm package (no
checkout needed; ≥ 0.5.1, which carries the imapflow TLS fix at runtime —
older versions need the repo's pnpm patch). Note that a plain `bun add -g`
shim executes `dist/main.js` under node via its shebang, so the compile step
is what buys the ~11 ms cold start:

```bash
bun add -g @codefuturist/email-mcp
bun build --compile --minify --bytecode \
  "${BUN_INSTALL:-$HOME/.bun}/install/global/node_modules/@codefuturist/email-mcp/dist/main.js" \
  --outfile ~/.local/bin/email-mcp
```

An installed binary keeps itself current: `email-mcp update` checks the latest
release and — after a confirmation, a sha256 check against the release's
checksums file, and (when the `gh` CLI is present) a provenance-attestation
check — atomically replaces itself. `--check` only reports (exit code 1 =
update available), `--yes` skips the prompt for scripts. npm- and mise-managed
installs are recognized and pointed at `npm install -g …@latest` /
`mise upgrade` instead of being overwritten.

`server install` from the binary points the launchd login item at it. Requires the
bundled imapflow patch (`patches/`) — imapflow passes `servername: false` to
tls.connect for IP hosts, which Bun's stricter node:tls rejects.

### Docker

No Node.js required — just Docker.

```bash
# Latest stable release
docker pull ghcr.io/codefuturist/email-mcp:latest

# Pin to an exact version (immutable)
docker pull ghcr.io/codefuturist/email-mcp:0.2.3

# Auto-update patches within a minor version
docker pull ghcr.io/codefuturist/email-mcp:0.2

# Track a major version (won't cross breaking-change boundary)
docker pull ghcr.io/codefuturist/email-mcp:0

# Pin to an exact git commit (immutable, CI traceability)
docker pull ghcr.io/codefuturist/email-mcp:sha-abc1234

# Or build from source
docker build -t ghcr.io/codefuturist/email-mcp .
```

> **Tag convention:** Tags follow bare semver (no `v` prefix), matching Docker ecosystem standards (e.g. `node:24`, `nginx:1.25`). The `latest` tag is only updated on stable releases, never pre-releases.

> **Note:** By default, the server uses stdio transport. Config must be created on the host first
> (via `npx @codefuturist/email-mcp setup` or manually) and mounted into the container.

## Usage

### Setup

```bash
# Add an email account interactively (recommended)
# On macOS and Linux this offers to store the password in the OS keychain,
# so config.toml only carries a `keychain:<account>` reference.
email-mcp account add

# Or use the legacy alias
email-mcp setup

# Or create a template config manually
email-mcp config init
```

The setup wizard auto-detects server settings, tests connections, saves config, and outputs the MCP client config snippet.

### Test Connections

```bash
email-mcp test            # all accounts
email-mcp test personal   # specific account
```

### Configure Your MCP Client

The snippets below use the default **stdio** transport, best for local desktop clients. For networked or remote access over **Streamable HTTP**, see [Streamable HTTP (networked)](#streamable-http-networked) below.

**Recommended — use the guided installer** (auto-detects Claude Desktop, Cursor, Windsurf; for VS Code use the manual snippet below):

```bash
email-mcp install
```

Or add manually using the snippets below.

<details>
<summary><strong>Claude Desktop</strong></summary>

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "email": {
      "command": "npx",
      "args": ["-y", "@codefuturist/email-mcp", "stdio"]
    }
  }
}
```
</details>

<details>
<summary><strong>VS Code (GitHub Copilot)</strong></summary>

**Option 1 — Extensions gallery (easiest):**
1. Open the Extensions view (<kbd>⇧⌘X</kbd> / <kbd>Ctrl+Shift+X</kbd>)
2. Search `@mcp email-mcp`
3. Click **Install** (user-wide) or right-click → **Install in Workspace**

**Option 2 — Workspace config** (`.vscode/mcp.json`, committed to source control):

```json
{
  "servers": {
    "email": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@codefuturist/email-mcp", "stdio"]
    }
  }
}
```

**Option 3 — User config** (`settings.json`, applies to all workspaces):

Open the Command Palette → **Preferences: Open User Settings (JSON)** and add:

```json
{
  "mcp": {
    "servers": {
      "email": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@codefuturist/email-mcp", "stdio"]
      }
    }
  }
}
```
</details>

<details>
<summary><strong>Cursor</strong></summary>

Edit `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "email": {
      "command": "npx",
      "args": ["-y", "@codefuturist/email-mcp", "stdio"]
    }
  }
}
```
</details>

<details>
<summary><strong>Windsurf</strong></summary>

Edit `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "email": {
      "command": "npx",
      "args": ["-y", "@codefuturist/email-mcp", "stdio"]
    }
  }
}
```
</details>

<details>
<summary><strong>Zed</strong></summary>

Edit `~/.config/zed/settings.json`:

```json
{
  "context_servers": {
    "email": {
      "command": {
        "path": "npx",
        "args": ["-y", "@codefuturist/email-mcp", "stdio"]
      }
    }
  }
}
```
</details>

<details>
<summary><strong>Mistral Vibe</strong></summary>

Add to `~/.vibe/config.toml`:

```toml
[[mcp_servers]]
name = "email-mcp"
transport = "stdio"
command = "npx"
args = ["-y", "@codefuturist/email-mcp", "stdio"]
```

To pass credentials directly instead of using a config file, use the `env` field:

```toml
[[mcp_servers]]
name = "email-mcp"
transport = "stdio"
command = "npx"
args = ["-y", "@codefuturist/email-mcp", "stdio"]
env = { "EMAIL_ACCOUNTS" = "<your-accounts-json>" }
```

MCP tools are exposed as `email-mcp_<tool_name>` (e.g. `email-mcp_list_emails`). Restart Vibe after editing the config.

</details>

<details>
<summary><strong>Docker (any MCP client)</strong></summary>

Run the server in a container — mount your config directory read-only:

```bash
docker run --rm -i \
  -v ~/.config/email-mcp:/home/node/.config/email-mcp:ro \
  -v email-mcp-state:/home/node/.local/state/email-mcp \
  -v email-mcp-cache:/home/node/.cache/email-mcp \
  ghcr.io/codefuturist/email-mcp
```

The config mount can stay read-only, but **state and cache must be persisted**.
The image declares both as volumes, so Docker keeps them in anonymous volumes
if you omit the flags — naming them, as above, is what makes them survive a
`docker run --rm`. State holds the scheduled-email queue: without it, a restart
drops every email scheduled but not yet sent. Cache holds the local mirror,
which is regenerable, so losing that only costs a re-sync.

For MCP client configuration (e.g. Claude Desktop):

```json
{
  "mcpServers": {
    "email": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "-v", "~/.config/email-mcp:/home/node/.config/email-mcp:ro",
        "-v", "email-mcp-state:/home/node/.local/state/email-mcp",
        "-v", "email-mcp-cache:/home/node/.cache/email-mcp",
        "ghcr.io/codefuturist/email-mcp"
      ]
    }
  }
}
```
</details>

<details>
<summary><strong>Single-account via environment variables (no config file needed)</strong></summary>

```json
{
  "mcpServers": {
    "email": {
      "command": "npx",
      "args": ["-y", "@codefuturist/email-mcp", "stdio"],
      "env": {
        "MCP_EMAIL_ADDRESS": "you@gmail.com",
        "MCP_EMAIL_PASSWORD": "your-app-password",
        "MCP_EMAIL_IMAP_HOST": "imap.gmail.com",
        "MCP_EMAIL_SMTP_HOST": "smtp.gmail.com"
      }
    }
  }
}
```
</details>

### Always-on server (detached)

The stdio transport lives only as long as an MCP client keeps it open — which also
means the IMAP watcher (and verification catching) stop with it. `email-mcp server`
runs the Streamable HTTP server as a background service instead, iMCP-style:

```bash
email-mcp server start              # detached on http://127.0.0.1:8080/mcp
email-mcp server start --port 3199  # any http flags pass through (--host, --token, …)
email-mcp server start --attach     # foreground instead (Ctrl-C stops)
email-mcp server status             # pid, address, /healthz, uptime
email-mcp server logs -n 50         # tail the daemon log
email-mcp server restart            # reuses the previous flags
email-mcp server stop               # graceful SIGTERM (add --force for SIGKILL)
```

The binding lives in the config file, so a plain `server start` is deterministic:

```toml
[settings.server]
host = "127.0.0.1"
port = 8080
path = "/mcp"
token = ""            # bearer token; empty = no auth (loopback only)
allowed_hosts = []    # Host-header allowlist for reverse proxies
```

Precedence: CLI flags → `EMAIL_MCP_HTTP_*` env → `[settings.server]` → defaults —
for `email-mcp http`, `server start`, and the launchd login item alike. Edit it
interactively with `config edit server` (the token renders masked). `--insecure`
is deliberately flag-only and cannot be persisted.

**Start at login (macOS):** `email-mcp server install` writes a launchd login item
(`com.email-mcp.server`, RunAtLoad + KeepAlive) running `email-mcp http` with no
flags — the config file is its single source of truth across reboots and crashes.
`server status` recognizes the launchd mode; `server uninstall` removes it.

State lives in `$XDG_STATE_HOME/email-mcp/daemon.json`, logs in `server.log` next to
it (rotated at 5 MB). `stop` only ever signals a process whose command line is
verifiably this server (PID-reuse safe). Point HTTP-capable MCP clients at
`http://127.0.0.1:8080/mcp`; binding non-loopback hosts still requires a token.

### Streamable HTTP (networked)

By default the server speaks MCP over **stdio**, ideal for local desktop clients (see the snippets above). For networked or remote access, run it as a **Streamable HTTP** server instead:

```bash
email-mcp http --port 8080
```

This serves MCP at `http://127.0.0.1:8080/mcp`, with a health probe at `GET /healthz`.

#### Flags & environment variables

| Flag | Environment variable | Default | Description |
|------|----------------------|---------|-------------|
| `--host <addr>` | `EMAIL_MCP_HTTP_HOST` | `127.0.0.1` | Address to bind |
| `--port <n>` | `EMAIL_MCP_HTTP_PORT` | `8080` | Port to listen on |
| `--path <path>` | `EMAIL_MCP_HTTP_PATH` | `/mcp` | HTTP path serving MCP |
| `--token <secret>` | `EMAIL_MCP_HTTP_TOKEN` | — | Require `Authorization: Bearer <secret>` on every request |
| `--allowed-hosts a,b,c` | `EMAIL_MCP_HTTP_ALLOWED_HOSTS` | _loopback names + bind host_ | Comma-separated `Host` header allowlist (DNS-rebinding protection); `*` disables the check |
| `--insecure` | — | `false` | Allow binding a non-loopback host without a token |

#### Security

- **Token auth** — When a token is set, every request must send `Authorization: Bearer <token>`.
- **Non-loopback bind guard** — Binding a non-loopback host (e.g. `0.0.0.0`) **without** a token is refused unless `--insecure` is passed. Use `--insecure` only when TLS and authentication are terminated by an upstream reverse proxy.
- **DNS-rebinding protection** — The `Host` header is validated against an allowlist (loopback names plus the bind host by default). Set `EMAIL_MCP_HTTP_ALLOWED_HOSTS` to your public domain, or `*` to disable the check when a proxy already enforces it.

#### Client configuration

For clients that support the Streamable HTTP transport:

```json
{
  "mcpServers": {
    "email": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:8080/mcp"
    }
  }
}
```

When a token is configured, add an `Authorization: Bearer <token>` header if your client supports custom headers.

#### Docker

```bash
docker compose --profile http up
```

Requires `EMAIL_MCP_HTTP_TOKEN` to be set; the image `EXPOSE`s port `8080`.

### CLI Commands

```
email-mcp [command]

Commands:
  stdio                     Run as MCP server over stdio (default)
  http                      Run as MCP server over Streamable HTTP (networked)
  server start [--attach]   Start an always-on HTTP server (detached by default)
  server stop [--force]     Stop the detached server
  server status             Show pid, address, health, uptime (exit 1 if stopped)
  server restart            Stop and start again (reuses previous flags)
  server logs [-n N]        Show the last N daemon log lines
  server install            Install as macOS login item (launchd, survives reboots)
  server uninstall          Remove the login item and stop the server
  account list              List all configured accounts
  account add               Add a new email account interactively
  account edit [name]       Edit an existing account
  account delete [name]     Remove an account
  setup                     Alias for 'account add'
  test                      Test connections for all or a specific account
  open <id> [--print]       Open an email in the native mail client via its message: link
                            (macOS; --print or other platforms print the URL instead)
  install                   Register email-mcp with MCP clients interactively
  install status            Show registration status for detected clients
  install remove            Unregister email-mcp from MCP clients
  config show               Show config (passwords masked)
  config edit [section]     Interactive settings editor (general, server, send, attachments,
                            scheduler, watcher, verification, cache, hooks, alerts)
  config validate           Check syntax, schema, typo'd keys, and cross-setting consistency
  completion zsh|bash|fish  Print shell completion script (accounts and sections complete dynamically)
  config path               Print config file path
  config init               Create template config
  scheduler check           Process pending scheduled emails
  scheduler list            Show all scheduled emails
  scheduler install         Install OS-level scheduler (launchd/crontab)
  scheduler uninstall       Remove OS-level scheduler
  scheduler status          Show scheduler installation status
  cache status [--json]     Show cache size, contents, coverage and freshness
  cache clear [--account N] Delete cached mail/attachments and free the disk space
                            (--json supported by status, clear and verify)
  cache verify              Check the cache for corruption and reclaim orphaned files
  update [--check|--yes]    Self-update the binary to the latest GitHub release
  help                      Show help
```

### Shell completion

```bash
# zsh (one line in ~/.zshrc)
source <(email-mcp completion zsh)

# bash
source <(email-mcp completion bash)

# fish
email-mcp completion fish > ~/.config/fish/completions/email-mcp.fish
```

Completions cover every command, subcommand, and flag — and complete **account
names from your config** (`email-mcp test <TAB>`, `account edit <TAB>`) and
**settings sections** (`config edit <TAB>`) dynamically.

### Checking logs

The background daemon logs to `$XDG_STATE_HOME/email-mcp/server.log`. View it
with a tail/follow/filter viewer — no need to find the file:

```bash
email-mcp logs                 # last 40 lines (colored by level)
email-mcp logs -n 200          # more lines
email-mcp logs -f              # live follow (Ctrl-C to stop)
email-mcp logs --level warn    # only WARN and ERROR (continuation lines kept)
email-mcp logs --grep imap     # only lines matching a substring
email-mcp logs -f --level error  # watch for errors as they happen
```

`email-mcp server logs` is an alias with the same options. Color auto-disables
when piped or under `NO_COLOR`; on a systemd host, `journalctl --user -u
email-mcp` is also available.

### Reading and sending mail from the CLI

Beyond running as an MCP server, `email-mcp` is a usable mail client in its own
right — no MCP client and no coding required. Commands default to your first
configured account (pass `--account <name>` to pick another), print clean,
colored tables (color auto-disables when piped or under `NO_COLOR`), and tab
complete (see [Shell completion](#shell-completion)).

```bash
email-mcp list                       # recent INBOX messages (● unread, ★ flagged, 📎 attachment)
email-mcp list --unread --limit 50   # filters
email-mcp list --mailbox Archive --search invoice
email-mcp read 42                    # full message (headers, body, attachment names + sizes)
email-mcp read 42 --mark-read
email-mcp search "from bank"         # IMAP search
email-mcp mailboxes                  # folders with unread/total counts
email-mcp flag 42                    # flag / --off to unflag
email-mcp attach 42 report.pdf ~/Downloads   # save an attachment
email-mcp delete 42 --yes            # delete (asks to confirm without --yes)

email-mcp reply 42 --body "on it" --all
email-mcp send --to a@b.c,d@e.f --subject "Hi" --body "..." --attach ./file.pdf
```

Every command accepts `--help`; the read commands (`list`, `read`, `search`,
`mailboxes`) accept `--json` for machine-readable output you can pipe to `jq`:

```bash
email-mcp list --json | jq '.items[] | {id, subject, from: .from.address}'
email-mcp read 42 --json | jq .attachments
```

Attachment sizes on send/reply are checked against the configured limit before
anything leaves your machine (see [Storing account secrets](#storing-account-secrets)
for keeping credentials out of plaintext).

### Configuration

Located at `$XDG_CONFIG_HOME/email-mcp/config.toml` (default: `~/.config/email-mcp/config.toml`). Validate it with `email-mcp config validate` (TOML syntax, schema, typo'd keys with did-you-mean, cross-setting consistency; exit 1 on errors — CI-friendly) and edit it interactively with `email-mcp config edit [section]` — every save validates first and backs up the previous file to `config.toml.bak`. Note: programmatic saves rewrite the file without TOML comments (the backup keeps them).

```toml
[settings]
rate_limit = 10  # max emails per minute per account

[settings.send]
max_attachment_mb = 25  # global cap on the base64-encoded attachment total
save_to_sent = false    # file a copy of each sent message in the IMAP Sent folder

[settings.attachments]
auto_download = true  # save attachments locally when calendar events are created from emails

[settings.attachment_download]
# dir = "/data/attachments"  # unset (default) disables download_attachment's saveToDownloadDir
allowed_extensions = ["pdf", "png", "jpg", "jpeg", "webp", "tiff", "txt", "md", "doc", "docx", "odt", "xls", "xlsx", "csv"]
max_bytes = 26214400  # 25 MB

[[accounts]]
name = "personal"
email = "you@gmail.com"
full_name = "Your Name"
password = "keychain:personal"  # or "env:VAR", or a plaintext app password
# max_attachment_mb = 25  # optional per-account override (beats global + provider limits)
# sent_mailbox = "INBOX.Sent Messages"  # optional, see "Sent-folder copies" below
# save_to_sent = true                    # optional per-account override of the Gmail-skip guess

[accounts.imap]
host = "imap.gmail.com"
port = 993
tls = true

[accounts.smtp]
host = "smtp.gmail.com"
port = 465
tls = true
starttls = false
verify_ssl = true

[accounts.smtp.pool]
enabled = true
max_connections = 1
max_messages = 100
```

#### Storing account secrets

The `password` field (and OAuth2 `client_secret` / `refresh_token`) accepts an
indirection so credentials need not sit in the file as plaintext:

| Value | Resolved from |
|---|---|
| `keychain:<account>` | OS keychain — macOS Keychain (`security`) or Linux libsecret (`secret-tool`), service `email-mcp`, account `<account>` |
| `keychain:<service>/<account>` | macOS Keychain with an explicit service name |
| `env:<VAR>` | the environment variable `<VAR>` (use on Linux, or with an age/SOPS-sourced env) |
| any other string | used literally (plaintext — backward compatible) |

The config file itself is always written `0600` (owner-only), and so is its
`.bak`.

**macOS Keychain (multi-account):** store each account's secret once —

```bash
email-mcp account set-secret personal      # store a NEW secret (prompts; nothing echoed or in argv)
email-mcp account migrate-secret personal  # move an EXISTING plaintext password into the keychain
```

`set-secret` prompts for the value and stores it; `migrate-secret` reads the
account's current plaintext password from `config.toml`, stores it in the
keychain, verifies it, then rewrites the line to `password = "keychain:personal"`.
Either way you end up with `password = "keychain:personal"`. Each account is a separate Keychain
item under the shared `email-mcp` service, so multiple accounts coexist.
Secrets are read back at startup over the `security` CLI; only the service and
account names are ever passed as arguments — the secret travels on stdout only.

At rest the secret lives in your **login keychain**, encrypted and unlocked by
your macOS login (Touch ID at the login level). A running `email-mcp` daemon
reads it once at startup; it does **not** prompt for Touch ID on every IMAP
reconnect — per-access biometric prompts are deliberately not used for an
unattended background service. (True per-access Touch ID would require the
data-protection keychain and a native helper.)

#### OAuth2 _(experimental)_

> **Note:** OAuth2 support is experimental. Token refresh and provider-specific flows may require additional testing in your environment.

```toml
[[accounts]]
name = "work"
email = "you@company.com"
full_name = "Your Name"

[accounts.oauth2]
provider = "google"            # or "microsoft"
client_id = "your-client-id"
client_secret = "your-client-secret"
refresh_token = "your-refresh-token"

[accounts.imap]
host = "imap.gmail.com"
port = 993
tls = true

[accounts.smtp]
host = "smtp.gmail.com"
port = 465
tls = true

[accounts.smtp.pool]
enabled = true
max_connections = 1
max_messages = 100
```

#### Environment Variables

For single-account setups (overrides config file):

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_EMAIL_ADDRESS` | *required* | Email address |
| `MCP_EMAIL_PASSWORD` | *required* | Password or app password |
| `MCP_EMAIL_IMAP_HOST` | *required* | IMAP server hostname |
| `MCP_EMAIL_SMTP_HOST` | *required* | SMTP server hostname |
| `MCP_EMAIL_ACCOUNT_NAME` | `default` | Account name |
| `MCP_EMAIL_FULL_NAME` | — | Display name |
| `MCP_EMAIL_USERNAME` | *email* | Login username |
| `MCP_EMAIL_IMAP_PORT` | `993` | IMAP port |
| `MCP_EMAIL_IMAP_TLS` | `true` | IMAP TLS |
| `MCP_EMAIL_SMTP_PORT` | `465` | SMTP port |
| `MCP_EMAIL_SMTP_TLS` | `true` | SMTP TLS |
| `MCP_EMAIL_SMTP_STARTTLS` | `false` | SMTP STARTTLS |
| `MCP_EMAIL_SMTP_VERIFY_SSL` | `true` | Verify SSL certificates |
| `MCP_EMAIL_SMTP_POOL_ENABLED` | `true` | Enable SMTP transport pooling |
| `MCP_EMAIL_SMTP_POOL_MAX_CONNECTIONS` | `1` | Max pooled SMTP connections |
| `MCP_EMAIL_SMTP_POOL_MAX_MESSAGES` | `100` | Max messages per pooled connection |
| `MCP_EMAIL_RATE_LIMIT` | `10` | Max sends per minute |
| `MCP_EMAIL_SEND_SAVE_TO_SENT` | `false` | `true` appends a copy of each sent message to the IMAP Sent folder |
| `MCP_EMAIL_READ_ONLY` | `false` | `true` unregisters the mailbox-write tools (send, move, delete, labels, bulk). Calendar/Reminders writes, clipboard copy and config-writing tools stay available — it is a mailbox guard, not a global one. |
| `MCP_EMAIL_SCHEDULER_SENT_RETENTION_DAYS` | `90` | Days of sent-email history to keep; `0` keeps everything |
| `MCP_EMAIL_ATTACHMENT_DOWNLOAD_DIR` | — | Directory `download_attachment`'s `saveToDownloadDir` writes into; unset disables the option |
| `MCP_EMAIL_ATTACHMENT_DOWNLOAD_ALLOWED_EXTENSIONS` | *(built-in list — see below)* | Comma-separated extension allowlist for saved attachments |
| `MCP_EMAIL_ATTACHMENT_DOWNLOAD_MAX_BYTES` | `26214400` (25 MB) | Max attachment size `saveToDownloadDir` will write |

### Local Cache

Reads are served from a local SQLite mirror of your mail (plus a
content-addressed store for attachments) under
`${XDG_CACHE_HOME:-~/.cache}/email-mcp/`. It makes listing, searching, and
re-reading mail fast, and it keeps mail readable when the mail server is
unreachable. It is on by default.

**The cache is never authoritative.** Every row can be re-fetched from IMAP, so
deleting it costs a resync and never loses mail — you can remove the directory
at any time, as the XDG cache convention allows.

#### Seeing and reclaiming what it holds

```bash
email-mcp cache status          # size vs budget, per-mailbox coverage, last sync
email-mcp cache status --json   # same, for scripts
email-mcp cache clear           # free the space (asks first; mail is re-fetched)
email-mcp cache clear --account work --yes
email-mcp cache verify          # integrity check + reclaim orphaned files
```

`cache status` reports the index size and attachment bytes separately, how many
messages have full text cached, and how long ago each mailbox was reconciled.
`check_health` exposes the same numbers to an AI client, plus the read hit ratio.

#### How freshness is decided

Correctness comes first: a stale answer to "any new mail?" is a wrong answer.
Before serving a mailbox from the cache, the server either trusts a reconcile
from the last 10 seconds, or spends one `STATUS` round trip comparing the
server's `UIDVALIDITY`/`UIDNEXT`/`HIGHESTMODSEQ`/`MESSAGES` against what the
mirror recorded — the IMAP equivalent of a conditional request. If anything
moved, it resynchronises before answering (bounded; past the bound you get the
cached answer marked `stale`). If the server is unreachable you get the cached
answer marked `offline`.

Message bodies and attachments are immutable for a given `UIDVALIDITY`/UID, so
once stored they are served with no revalidation at all. Writes made through
this server (flagging, moving, deleting) resynchronise the affected mailboxes
immediately, which matters on servers without `CONDSTORE` where a flag change
is otherwise invisible.

#### Settings

| Setting | Default | What it does |
|---|---|---|
| `enabled` | `true` | `false` reads live from IMAP every time |
| `mailboxes` | `["INBOX"]` | Synced in the background. Others mirror lazily once read |
| `window_days` | `0` (all) | How far back the first sync of a mailbox reaches |
| `body_messages` | `500` | Bodies kept per mailbox. `0` keeps the cache metadata-only |
| `max_size_mb` | `500` | Budget for index + attachments combined |
| `sync_interval` | `300` | Seconds between background reconciles |

Past the budget, eviction runs cheapest-to-rebuild-first: attachment files
(least recently read first), then message bodies, then envelopes older than
`window_days`. Envelopes are kept as long as possible, because they are what
listings and search need.

**Coverage, not just freshness.** The cache only answers a listing when it
holds every message the server reports for that mailbox. Set `window_days` to
something other than `0` and the mirror becomes a slice — it then cannot report
a truthful `total` or know whether more pages exist, so reads fall back to the
live path until it catches up. That is also why envelope eviction clears the
mailbox's sync watermarks: the next sync rebuilds coverage instead of leaving a
permanent, invisible hole.

#### Data at rest

Cached mail — including message bodies and attachment content — is stored
**unencrypted**, in a directory and files readable only by your user
(`0700`/`0600`). This matches what desktop mail clients do; the recommended
protection is full-disk encryption (FileVault, LUKS). If you would rather not
have bodies and attachments on disk at all, set `body_messages = 0`, which
keeps the cache metadata-only.

Gmail note: do not add `[Gmail]/All Mail` to `mailboxes`. Gmail presents the
same message in every label folder, so mirroring All Mail alongside INBOX
stores the same mail twice.

### Email Scheduling

The scheduler enables future email delivery with a layered architecture:

1. **MCP auto-check** — Processes the queue on server startup and every 60 seconds while the MCP server is running
2. **CLI** — `email-mcp scheduler check` for manual or cron-based processing
3. **OS-level daemon** — `email-mcp scheduler install` sets up launchd (macOS) or crontab (Linux) to run every minute, independently of the MCP server

> **Important — the daemon must be installed for reliable delivery.**
> Without it, scheduled emails only fire while an AI client is actively connected.
> Your machine also needs to be running at the scheduled time; if it's asleep or
> off, the daemon will process overdue emails on next wake/startup. Failed sends
> are retried up to **3 times** before being marked `failed`.

#### Setting up the daemon

```bash
# Install (macOS launchd / Linux crontab — runs every minute)
email-mcp scheduler install

# Verify it's running
email-mcp scheduler status

# View pending / sent / failed scheduled emails
email-mcp scheduler list

# Trigger a manual check immediately
email-mcp scheduler check

# Remove the daemon
email-mcp scheduler uninstall
```

Scheduled emails are stored as JSON files in `~/.local/state/email-mcp/scheduled/` with status-based locking. Each entry tracks attempts (max 3) and the last error, so you can inspect failures with `scheduler list`.

### Real-time Watcher & AI Hooks

The IMAP IDLE watcher monitors configured mailboxes in real-time using persistent IDLE connections (separate from tool connections). When new emails arrive:

1. **Static rules** — Pattern-match on from/to/subject → apply labels, flag, or mark read instantly (no AI)
2. **AI triage** — Remaining emails are analyzed via MCP sampling with a customizable preset prompt
3. **Notify mode** — Falls back to logging if AI triage is disabled

Configure in `config.toml`:

```toml
[settings.watcher]
enabled = true
folders = ["INBOX"]
idle_timeout = 1740     # 29 minutes (IMAP spec max is 30)

[settings.hooks]
on_new_email = "triage" # "triage" | "notify" | "none"
preset = "inbox-zero"   # "inbox-zero" | "gtd" | "priority-focus" | "notification-only" | "custom"
auto_label = true       # apply AI-suggested labels
auto_flag = true        # flag urgent emails
batch_delay = 5         # seconds to batch before triage

# User context — appended to preset's AI prompt
custom_instructions = """
I'm a software engineer. Emails from @mycompany.com are always high priority.
Newsletters I read: TL;DR, Hacker Newsletter.
"""

# Static rules — run BEFORE AI, skip AI if matched
[[settings.hooks.rules]]
name = "GitHub Notifications"
match = { from = "*@github.com" }
actions = { labels = ["Dev"], mark_read = true }

[[settings.hooks.rules]]
name = "Newsletter Archive"
match = { from = "*@substack.com|*@buttondown.email" }
actions = { labels = ["Newsletter"] }

[[settings.hooks.rules]]
name = "VIP Contacts"
match = { from = "ceo@company.com|cto@company.com" }
actions = { flag = true, labels = ["VIP"] }
```

#### Presets

| Preset | Focus | Suggested Labels |
|--------|-------|------------------|
| `inbox-zero` | Aggressive categorization + archiving | Newsletter, Notification, Updates, Finance, Social, Promo |
| `gtd` | Getting Things Done contexts | @Action, @Waiting, @Reference, @Someday, @Delegated |
| `priority-focus` | Simple priority classification (default) | _(none — just priority + flag)_ |
| `notification-only` | No AI triage, just log | _(none)_ |
| `custom` | User defines full system prompt | User-defined |

#### Static Rules

Static rules use glob-style patterns (`*@github.com`) with `|` as OR separator (`*@github.com|*@gitlab.com`). All conditions within a match are AND'd. First matching rule wins.

Available actions: `labels` (string array), `flag` (boolean), `mark_read` (boolean), `alert` (boolean — forces desktop notification).

#### Alerts

Urgency-based multi-channel notification routing — grab attention for important emails even when you're not looking at the chat. All channels are **opt-in** and disabled by default.

| Priority | Desktop | Sound | MCP Log Level | Webhook |
|----------|---------|-------|---------------|---------|
| `urgent` | ✅ Banner | 🔊 Alert | `alert` | ✅ |
| `high` | ✅ Banner | 🔇 Silent | `warning` | ✅ |
| `normal` | ❌ | ❌ | `info` | ❌ |
| `low` | ❌ | ❌ | `debug` | ❌ |

```toml
[settings.hooks.alerts]
desktop = true              # OS-level notifications (macOS/Linux/Windows)
sound = true                # play sound for urgent emails
urgency_threshold = "high"  # minimum priority to trigger desktop alert
webhook_url = "https://ntfy.sh/my-email-alerts"  # optional: Slack, Discord, ntfy.sh, etc.
webhook_headers = { Authorization = "Bearer <token>" }  # optional: extra headers (auth) for the POST
webhook_events = ["urgent", "high"]
```

`webhook_headers` is for endpoints that require authentication. Env-only setups can use
`MCP_EMAIL_ALERT_WEBHOOK_HEADERS='{"Authorization":"Bearer <token>"}'` (a JSON object of strings;
malformed JSON fails at startup instead of sending the webhook unauthenticated). Header values are
never logged or shown by the watcher tools, and `Content-Type: application/json` is always sent.

**Supported platforms:** macOS (Notification Center via `osascript`), Linux (`notify-send`), Windows (PowerShell toast). Zero npm dependencies — uses native OS commands.

**Notification setup by platform:**

<details>
<summary>macOS</summary>

Desktop notifications use `osascript` (built-in). The terminal app running the MCP server needs notification permission:

1. Open **System Settings → Notifications & Focus**
2. Find your terminal app (Terminal, iTerm2, VS Code, Cursor, etc.)
3. Enable **Allow Notifications** and choose **Banners** or **Alerts**
4. Ensure **Focus** / Do Not Disturb is not blocking notifications

Use `check_notification_setup` to diagnose and `test_notification` to verify.
</details>

<details>
<summary>Linux</summary>

Requires `notify-send` from `libnotify`. For sound alerts, `paplay` is also needed:

```bash
# Ubuntu / Debian
sudo apt install libnotify-bin pulseaudio-utils

# Fedora
sudo dnf install libnotify pulseaudio-utils

# Arch
sudo pacman -S libnotify
```

Desktop notifications require a running display server (X11/Wayland) — they will not work in headless/SSH sessions.
</details>

<details>
<summary>Windows</summary>

Uses PowerShell toast notifications (built-in):

1. Open **Settings → System → Notifications**
2. Ensure **Notifications** is turned on
3. Set **Focus Assist** to allow notifications
4. If using Windows Terminal, ensure its notifications are enabled
</details>

**AI-configurable:** The AI can check, test, and configure notifications at runtime:
- `check_notification_setup` — diagnose platform support and show setup instructions
- `test_notification` — send a test notification to verify everything works
- `configure_alerts` — enable/disable desktop, sound, threshold, webhook (with optional persist to config file)

**Webhook payload:**
```json
{
  "event": "email.urgent",
  "account": "work",
  "sender": { "name": "John CEO", "address": "ceo@company.com" },
  "subject": "Q4 Review Due Today",
  "priority": "urgent",
  "labels": ["VIP"],
  "rule": "VIP Contacts",
  "timestamp": "2026-02-18T11:30:00Z"
}
```

Static rules can force desktop notifications with `alert = true`, regardless of urgency threshold:
```toml
[[settings.hooks.rules]]
name = "VIP Contacts"
match = { from = "ceo@company.com" }
actions = { flag = true, alert = true, labels = ["VIP"] }
```

Features:
- **Auto-reconnect** — Exponential backoff (1s → 60s) on connection failures
- **Batching** — Groups arrivals within a configurable delay to reduce AI calls
- **Rate limiting** — Max 10 sampling calls per minute
- **Graceful degradation** — Falls back to notify mode if client doesn't support sampling
- **Resource subscriptions** — Pushes `notifications/resources/updated` for unread counts

#### Verification codes (instant OTP catch)

When a mail carrying a verification code (OTP/2FA) or sign-in magic link arrives, email-mcp
copies it to your clipboard within ~1–2 seconds and shows a notification —
**“✅ Code 482913 from GitHub — Copied to clipboard, clears in 60s”**. Press ⌘V / Ctrl+V, done.

Detection is scoring-based (English + German), not a bare digit regex: keyword proximity
(`verification`, `Bestätigungscode`, `expires`, …) minus negative context (order numbers,
invoices, tracking, Zoom passcodes, phone numbers, prices, dates). A miss beats a wrong
code on your clipboard.

```toml
[settings.watcher]
enabled = true              # REQUIRED for ambient catching (IMAP IDLE push)

[settings.verification]
enabled = true              # on by default
auto_copy = true            # copy caught codes/links to the clipboard
confirm_copy = false        # ask (native dialog) before touching the clipboard
notify = true               # desktop notification on catch
copy_links = true           # also catch magic links (only when no code found)
link_action = "open"        # "open" = offer to open links in the browser, "copy" = clipboard
clear_after_seconds = 60    # conditional auto-clear (0 = never)
max_age_minutes = 10        # ignore stale messages (IDLE replays)
accounts = []               # limit to specific accounts (empty = all)
sender_allowlist = []       # e.g. ["*@github.com", "*@google.com"]
sender_denylist = []
```

**Ask-first mode:** with `confirm_copy = true`, a native macOS dialog ("Code 482913 from
GitHub — Copy to clipboard?") appears before anything touches your clipboard. **Sign-in
links** get a three-button dialog by default (`link_action = "open"`): **Open** launches
the link in your default browser, **Copy** puts it on the clipboard, **Cancel** does
nothing — opening is *always* confirmed, since auto-launching a browser from mail content
would be a phishing hazard. Set `link_action = "copy"` for the silent clipboard behavior.
Dialogs are macOS-only (same mechanism as the calendar confirmation); elsewhere these
modes degrade to notification-only.

**Clipboard hygiene (macOS):** codes are written via a JXA `osascript` with the
`org.nspasteboard.ConcealedType` marker — the same convention 1Password/Bitwarden use — so
well-behaved clipboard managers (Maccy, Paste, …) never record them. The auto-clear is
conditional: the clipboard is only cleared if it still holds the caught value, so anything
you copied in the meantime is never stomped. Linux uses `wl-copy`/`xclip`, Windows uses
PowerShell `Set-Clipboard` (no concealment convention exists there). Zero npm dependencies.

**For agents:** `get_verification_code` fetches the newest code on demand — during an
automated signup, call it with `wait_seconds = 30` and it returns the code seconds after
the mail lands (event-driven with the watcher, 5 s polling without). If nothing arrives in
time, it returns `found: false` with a hint — just call it again.

**Security notes:** the clipboard is shared OS state — any app can read it while the code
is there (that window is bounded by `clear_after_seconds`). The code itself is never
written to server logs or the audit log; it does appear in `get_verification_code` results,
which is the point of that tool. Kill switches: `enabled = false` (feature off) or
`auto_copy = false` (notification only). Environment overrides: `MCP_EMAIL_VERIFICATION_*`
(`_ENABLED`, `_AUTO_COPY`, `_CONFIRM_COPY`, `_NOTIFY`, `_COPY_LINKS`, `_LINK_ACTION`,
`_CLEAR_AFTER_SECONDS`, `_MAX_AGE_MINUTES`, `_ACCOUNTS`, `_SENDER_ALLOWLIST`,
`_SENDER_DENYLIST`).

Use `check_clipboard_setup` to diagnose the pipeline (add `test_write = true` for a
harmless copy → read-back → clear round-trip).

## API

### Tools (52)

> **Structured output:** `list_emails`, `search_emails`, `get_email_status`, `list_mailboxes`, and `get_verification_code` also return machine-readable results (`outputSchema` + `structuredContent`) alongside the human-readable text, for clients that consume typed tool output.

#### Email bodies: HTML and other formats

Nearly all real mail is HTML — in one sampled mailbox, 165 of 169 messages were
single-part `text/html` — so the read tools convert it rather than handing back
markup.

`get_email`, `get_emails`, and `get_thread` take a `format`:

| `format` | Body you get |
|---|---|
| `text` *(default)* | HTML converted to readable text: links become `[label](url)`, tables keep cell boundaries, lists are numbered or bulleted, quotes are `> `-prefixed, images become `[image: alt]` |
| `stripped` | As `text`, minus quoted reply chains and signatures |
| `full` | The raw body part, HTML included |

Bodies are capped by default — 10 000 characters for `get_email`, 5 000 per
message for `get_emails` and `get_thread` — and a hint reports how much was
left out. Pass `maxLength: 0` for no cap. Each side of the body (text, HTML) is
read up to 512 KB, shared across its parts.

Other formats behave as follows:

- **`multipart/alternative`** — both halves are fetched, so `bodyText` and
  `bodyHtml` are both available. A plain part too small to hold the same
  content as its HTML sibling is treated as a "view this in an HTML reader"
  placeholder and skipped.
- **`multipart/mixed` with several text parts** — concatenated in order, so a
  note split either side of an inline image (Apple Mail) or a per-message
  digest section is not truncated to its first part.
- **`text/plain; format=flowed`** (RFC 3676) — soft line wraps are undone, so
  paragraphs read as paragraphs rather than hard-wrapped at 72 columns;
  `DelSp` and space-stuffing are honoured.
- **Inline (`cid:`) images** — listed as attachments with `partId`,
  `contentId`, and `inline`, and downloadable via `download_attachment`'s
  `partId`. To embed one when sending, pass
  `{path, cid, contentType}` in `attachments` and reference it as
  `<img src="cid:…">`.
- **Bounces** (`multipart/report`) — the machine-readable
  `message/delivery-status` part is surfaced separately from the body.
- **Calendar invites** — handled by `extract_calendar` / `add_to_calendar`,
  honouring the part's declared charset.
- **Encrypted mail** (S/MIME, PGP/MIME) — not decrypted; the body says so
  plainly instead of appearing empty.
- **Attached messages** (`message/rfc822`) — never mistaken for the body, but
  used as the body when the message carries no other text (forward-as-attachment,
  digests).

**Attachment download directory.** `download_attachment` normally returns the
file base64-encoded (≤5 MB). Set `[settings.attachment_download] dir` (or
`MCP_EMAIL_ATTACHMENT_DOWNLOAD_DIR`) to a directory and pass
`saveToDownloadDir: true` to instead write the file there and get back its
path — useful for larger files, or when the caller just wants the attachment
on disk rather than inlined into the conversation. The option is unavailable
(the call fails) until `dir` is set — there is no default location. Only
`allowed_extensions` are written (default: common document/image types; see
the config example above); `max_bytes` caps the size, independent of the
5 MB base64 cap. Pass `saveAs` to choose the filename written there (a plain
basename — no path separators); otherwise the attachment's own filename is
sanitized and used. Running in Docker, point `dir` at a mounted volume shared
with whatever reads the files back, e.g. in `docker-compose.yml`:

```yaml
services:
  email-mcp:
    environment:
      MCP_EMAIL_ATTACHMENT_DOWNLOAD_DIR: /data/attachments
    volumes:
      - attachments:/data/attachments
  other-service:
    volumes:
      - attachments:/data/attachments:ro
volumes:
  attachments:
```

**Sent-folder copies.** SMTP delivers mail; it does not file it. `[settings.send]
save_to_sent` defaults to **false**; turn it on for an IMAP host that does not
capture sends itself. Gmail does capture sends server-side, so an account
whose IMAP server advertises the `X-GM-EXT-1` capability is skipped
automatically even with the setting on — filing a copy there would give you
two of everything. Set the account's own `save_to_sent` to force the decision
either way (`true` files anyway, `false` never files, regardless of the
global setting or the Gmail guess).

The copy carries the same `Message-ID` the server accepted, is flagged
`\Seen`, and lands in the folder the server marks `\Sent` (or a folder named
`Sent`, created if absent). On a mailbox that carries several sent-shaped
folders — a leftover `Sent` beside the one actually in use — that guess can
land on an empty one; set the account's `sent_mailbox` to the full path
(as `list_mailboxes` reports it) to settle it. The copy omits `Bcc`, which the
MIME composer strips unconditionally.

A failure to file never fails the send — the mail has already left, and
saying otherwise would invite a duplicate send — but `send_draft` keeps the
draft in that case rather than deleting the only remaining copy of the
message. `send_email`, `reply_email`, `forward_email` and `send_draft` all
report the outcome in their result's `sentCopy` field: `{kind: "filed", path}`,
`{kind: "skipped"}` (setting off, or Gmail's own capture), or
`{kind: "failed", error}`.

Outbound HTML (`html: true`) is sent as `multipart/alternative` with a
generated plain-text alternative. Forwards quote the original as converted
text; pass `html: true` to `forward_email` to also carry the original HTML.

#### Read (14)

| Tool | Description |
|------|-------------|
| `list_accounts` | List all configured email accounts |
| `list_mailboxes` | List folders with unread counts and special-use flags |
| `list_emails` | Paginated email listing with date, sender, subject, and flag filters; marks bulk mail; optional body preview |
| `get_email` | Read full email content with attachment metadata and bulk-mail classification (HTML converted to readable text by default) |
| `get_emails` | Fetch full content of multiple emails in a single call (max 20); same bulk markers |
| `get_email_status` | Get read/flag/label state of an email without fetching the body |
| `search_emails` | Search by keyword across subject, sender, and body; same bulk markers and optional preview as `list_emails` |
| `download_attachment` | Download an email attachment by filename or MIME part id, base64-encoded or (if configured) saved to the server's attachment download directory |
| `find_email_folder` | Discover the real folder(s) an email resides in (resolves virtual folders) |
| `extract_contacts` | Extract unique contacts from recent email headers |
| `get_thread` | Reconstruct a conversation thread via References/In-Reply-To; same bulk markers |
| `list_templates` | List available email templates |
| `get_email_stats` | Email analytics — volume, top senders, daily trends |
| `check_health` | Connection health, latency, quota, and IMAP capabilities |

#### Bulk-mail classification

`list_emails`, `search_emails`, `get_email`, `get_emails` and `get_thread` mark
list and machine-generated mail, so an inbox can be triaged without reading
bodies:

| Marker | Meaning | Derived from |
|--------|---------|--------------|
| 📰 `newsletter` | Mailing list or subscription | `List-Unsubscribe` (RFC 2369), `List-Id` (RFC 2919), `Precedence: list` |
| 🤖 `automated` | Machine-generated notification | `Auto-Submitted` (RFC 3834), `Precedence: bulk`/`junk` |
| _(none)_ | Ordinary person-to-person mail | no bulk headers present |

A newsletter also reports its unsubscribe URI when the sender offers one, and
flags `1-click` when RFC 8058 one-click unsubscribe is supported. The headers
are requested as part of the listing fetch, so classifying a whole page costs no
extra round trip.

Classification is header-derived and therefore deterministic — no model call and
no heuristics on subject text. A sender that omits the headers is reported as
personal mail rather than guessed at. These are sender-asserted headers, not
verified ones — treat the marker as a signal to weigh, not a fact to defer to.

#### Body previews

`list_emails` and `search_emails` accept `preview: true` to include roughly 200
characters of each message body. It is **off by default**: it fetches 1500 extra
bytes per message and lengthens the tool output, which is a cost the caller
should choose rather than inherit.

The preview is decoded from one body part rather than from message source —
IMAP section 1, or 1.1 when section 1 is itself a multipart. Because the fetch
stops at a byte count rather than at an encoding boundary, decoding tolerates
input cut mid-stream: base64 is truncated to a whole group, a half-written
quoted-printable escape is dropped, and the replacement character left by a
severed UTF-8 sequence is trimmed. Charsets beyond UTF-8 are handled — real mail
still ships `iso-8859-1`.

Markup is stripped whether or not the sender declared it, since bulk senders
routinely put HTML and stylesheets in a part labelled `text/plain`. Entities and
zero-width preheader padding are decoded, and a preview that reduces to markup
residue is omitted: **no preview beats a misleading one**.

#### Write (9)

| Tool | Description |
|------|-------------|
| `send_email` | Send a new email (plain text or HTML, CC/BCC) |
| `reply_email` | Reply with proper threading (In-Reply-To, References) |
| `forward_email` | Forward with original content quoted |
| `save_draft` | Save an email draft to the Drafts folder |
| `send_draft` | Send an existing draft and remove from Drafts |
| `apply_template` | Apply a template with variable substitution |
| `schedule_email` | Schedule an email for future delivery |
| `list_scheduled` | List scheduled emails by status |
| `cancel_scheduled` | Cancel a pending scheduled email |

#### Manage (7)

| Tool | Description |
|------|-------------|
| `move_email` | Move email between folders |
| `delete_email` | Move to Trash or permanently delete |
| `mark_email` | Mark as read/unread, flag/unflag |
| `bulk_action` | Batch operation on up to 100 emails |
| `create_mailbox` | Create a new mailbox folder |
| `rename_mailbox` | Rename an existing mailbox folder |
| `delete_mailbox` | Permanently delete a mailbox and contents |

#### Labels (5)

| Tool | Description |
|------|-------------|
| `list_labels` | Discover available labels (auto-detects provider strategy) |
| `add_label` | Add a label to an email (ProtonMail folders, Gmail X-GM-LABELS, or IMAP keywords) |
| `remove_label` | Remove a label from an email |
| `create_label` | Create a new label |
| `delete_label` | Delete a label |

#### Watcher & Alerts (6)

| Tool | Description |
|------|-------------|
| `get_watcher_status` | Show IMAP IDLE connections, folders being monitored, and last-seen UIDs |
| `list_presets` | List available AI triage presets with descriptions and suggested labels |
| `get_hooks_config` | Show current hooks configuration — preset, rules, and custom instructions |
| `configure_alerts` | Update alert/notification settings at runtime |
| `check_notification_setup` | Diagnose desktop notification support and provide setup instructions |
| `test_notification` | Send a test notification to verify OS permissions are configured |

#### Verification (3)

| Tool | Description |
|------|-------------|
| `get_verification_code` | Find (or wait up to 45 s for) the newest OTP/2FA code or sign-in magic link, with optional clipboard copy |
| `check_clipboard_setup` | Diagnose clipboard integration (platform tools, concealed-write support) with optional round-trip test |
| `configure_verification` | Update verification-catching settings at runtime (incl. starting/stopping the catcher), optional persist to config file |

#### Calendar & Reminders (8)

| Tool | Description |
|------|-------------|
| `extract_calendar` | Extract ICS/iCalendar events from an email |
| `analyze_email_for_scheduling` | Analyze an email to detect events and reminder-worthy content |
| `add_to_calendar` | Add an email event to the local calendar (macOS Calendar.app; on Linux hands the .ics to xdg-open); event notes link back to the source email |
| `create_reminder` | Create a reminder in macOS Reminders.app from an email; reminder notes link back to the source email |
| `list_calendars` | List all available local calendars (macOS Calendar.app; elsewhere a single placeholder) |
| `check_calendar_permissions` | Check whether the local calendar is accessible (macOS probes for real; elsewhere always reports accessible) |
| `list_events` | List events from the local calendar in a date range (macOS only; returns empty elsewhere) |
| `list_reminders` | List reminders from Reminders.app (macOS only) |

### Prompts (7)

| Prompt | Description |
|--------|-------------|
| `triage_inbox` | Categorize and prioritize unread emails with suggested actions |
| `summarize_thread` | Summarize an email conversation thread |
| `compose_reply` | Draft a context-aware reply to an email |
| `draft_from_context` | Compose a new email from provided context and instructions |
| `extract_action_items` | Extract actionable tasks from email threads |
| `summarize_meetings` | Summarize upcoming calendar events from emails |
| `cleanup_inbox` | Suggest emails to archive, delete, or unsubscribe from |

### Resources (6)

| Resource | URI | Description |
|----------|-----|-------------|
| Accounts | `email://accounts` | List of configured accounts |
| Mailboxes | `email://{account}/mailboxes` | Folder tree for an account |
| Unread | `email://{account}/unread` | Unread email summary |
| Templates | `email://templates/{name}` | One email template by name; the resource lists the available names |
| Stats | `email://{account}/stats` | Email statistics snapshot |
| Scheduled | `email://scheduled` | Pending scheduled emails |

### Provider Auto-Detection

| Provider | Domains |
|----------|---------|
| Gmail | gmail.com, googlemail.com |
| Outlook / Hotmail | outlook.com, hotmail.com, live.com, outlook.de, outlook.co.uk |
| Yahoo Mail | yahoo.com, yahoo.co.uk, yahoo.de, ymail.com |
| iCloud | icloud.com, me.com, mac.com |
| Fastmail | fastmail.com, fastmail.fm |
| ProtonMail Bridge | proton.me, protonmail.com, protonmail.ch, pm.me |
| Zoho Mail | zoho.com, zohomail.com |
| GMX | gmx.com, gmx.de, gmx.net, gmx.at, gmx.ch |

### Architecture

```
src/
├── main.ts                — Entry point and subcommand routing
├── server.ts              — MCP server factory
├── logging.ts             — MCP protocol logging bridge
├── cli/                   — Interactive CLI commands
│   ├── account-commands.ts — Account CRUD (list, add, edit, delete)
│   ├── setup.ts           — Legacy setup alias → account add
│   ├── test.ts            — Connection tester
│   ├── config-commands.ts — Config management (show, edit, path, init)
│   ├── install-commands.ts — MCP client registration (install, status, remove)
│   ├── cache-commands.ts  — Local-mirror CLI (status, clear, verify)
│   └── scheduler.ts       — Scheduler CLI
├── config/                — Configuration layer
│   ├── xdg.ts             — XDG Base Directory paths
│   ├── schema.ts          — Zod validation schemas
│   ├── providers.ts       — Provider auto-detection + OAuth2 endpoints (experimental)
│   └── loader.ts          — Config loader (TOML + env vars)
├── cache/                 — Local SQLite mirror
│   ├── schema.ts          — Mirror schema + migrations
│   ├── store.ts           — Read/write API over the mirror
│   └── sync-engine.ts     — Background reconcile + body backfill
├── connections/
│   └── manager.ts         — Lazy persistent IMAP/SMTP with OAuth2 (experimental)
├── services/              — Business logic
│   ├── imap.service.ts    — IMAP operations
│   ├── label-strategy.ts  — Provider-aware label strategy (ProtonMail/Gmail/IMAP keywords)
│   ├── smtp.service.ts    — SMTP operations
│   ├── template.service.ts — Email template engine
│   ├── oauth.service.ts   — OAuth2 token management (experimental)
│   ├── calendar.service.ts — ICS/iCalendar parsing
│   ├── scheduler.service.ts — Email scheduling queue
│   ├── watcher.service.ts — IMAP IDLE real-time watcher with auto-reconnect
│   ├── hooks.service.ts   — AI triage via MCP sampling + static rules + auto-labeling/flagging
│   ├── notifier.service.ts — Multi-channel notification dispatcher (desktop/sound/webhook)
│   ├── clipboard.service.ts — Concealed clipboard writes for caught codes (zero deps)
│   ├── dialog.service.ts   — Native confirm dialogs + browser hand-off (macOS)
│   ├── verification-catcher.service.ts — Instant OTP/magic-link catch on new mail
│   ├── presets.ts         — Built-in hook presets (inbox-zero, gtd, priority-focus, etc.)
│   └── event-bus.ts       — Typed EventEmitter for internal email events
├── tools/                 — MCP tool definitions (52)
├── prompts/               — MCP prompt definitions (7)
├── resources/             — MCP resource definitions (6)
├── safety/                — Audit trail and rate limiter
└── types/                 — Shared TypeScript types
```

## Roadmap

Ideas raised but deliberately not built yet, kept here so they aren't lost or
quietly re-proposed:

- **AgentMail as an alternative provider.** [AgentMail](https://agentmail.to)
  offers API-key-only, programmatic `@agentmail.to` inboxes — no IMAP/SMTP
  host/port/TLS/credential setup, useful for spinning up throwaway
  agent-owned addresses. It would be additive (a second provider alongside
  real IMAP/SMTP accounts, not a replacement), but is a product/architecture
  decision — a new vendor dependency and tool surface — rather than a bug fix
  or gap-fill, so it's parked here rather than auto-built. Revisit if there's
  real demand for agent-provisioned inboxes rather than access to existing
  mailboxes.

## Maintainers

[@codefuturist](https://github.com/codefuturist)

### Release prerequisites

`release.yml` checks these before publishing anything, so a missing one is a
fast red run rather than a half-published release:

| Secret | Needed for |
|---|---|
| `GORELEASER_KEY` | GoReleaser Pro license — `.goreleaser.yaml` uses Pro-only keys (`includes`, `variables`), and OSS rejects the whole config |
| `HOMEBREW_TAP_TOKEN` | PAT with `contents:write` on `codefuturist/homebrew-tap`; the default `GITHUB_TOKEN` cannot push to another repository |
| `NPM_TOKEN` | npm publish |
| `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` | Docker Hub push (GHCR uses `GITHUB_TOKEN`) |

The Homebrew cask ships the unsigned Bun binary, so its `postflight` clears
the macOS quarantine bit — macOS only, since Linux has no `xattr(1)` and the
cask DSL's `system_command` raises on a non-zero exit. `brew uninstall --zap`
trashes the config, state, cache and data directories plus the two launch
agents.

## Contributing

PRs accepted. Please conform to the [standard-readme](https://github.com/RichardLitt/standard-readme) specification when editing this README.

```bash
# Development workflow
pnpm install
pnpm typecheck   # type check
pnpm check       # lint and format
pnpm build       # build
pnpm start       # run
```

### Testing

```bash
pnpm test              # unit tests
pnpm test:integration  # against a throwaway GreenMail server (Docker required)
pnpm smoke             # most MCP tools against a real configured account (see caveats below)
```

The integration suite runs each tool against a throwaway GreenMail server
(spun up via Testcontainers). Attachment coverage
(`email-attachments.integration.test.ts`) drives the real MCP tool layer and
locks in the size-awareness contract: every send reports each file's size and
the raw≈base64 total, the cap is enforced on the **encoded** total (what the
wire carries), an over-cap send fails closed (nothing is delivered), and
forwards carry the original attachments unless `includeAttachments: false`.
The effective cap is resolved per account: an explicit per-account
`max_attachment_mb` wins outright; otherwise the stricter of the global
`[settings.send]` cap and the provider's documented limit applies (Gmail,
Yahoo, and Proton 25 MB; Outlook.com, iCloud, and GMX 20 MB; Fastmail 50 MB).

`pnpm smoke` drives all tools over stdio the way a client does, which reaches
what GreenMail cannot: provider quirks, real-world MIME, and the macOS
Calendar bridges. It needs a working account, so it is not part of CI. Writes
stay inside a scratch folder and a draft it creates itself; it does not touch
Calendar, Reminders, notifications, or `reply_email`, which would send mail to
a real correspondent. Pass `E2E_ACCOUNT=<name>` to choose an account, otherwise
it uses the first one configured.


## License

[LGPL-3.0-or-later](LICENSE)
