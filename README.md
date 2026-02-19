# Email MCP Server

[![standard-readme compliant](https://img.shields.io/badge/readme%20style-standard-brightgreen.svg?style=flat-square)](https://github.com/RichardLitt/standard-readme)
[![license](https://img.shields.io/github/license/codefuturist/email-mcp.svg?style=flat-square)](LICENSE)
[![npm version](https://img.shields.io/npm/v/@codefuturist/email-mcp.svg?style=flat-square)](https://www.npmjs.com/package/@codefuturist/email-mcp)
[![npm downloads](https://img.shields.io/npm/dm/@codefuturist/email-mcp.svg?style=flat-square)](https://www.npmjs.com/package/@codefuturist/email-mcp)
[![CI](https://img.shields.io/github/actions/workflow/status/codefuturist/email-mcp/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/codefuturist/email-mcp/actions/workflows/ci.yml)

An MCP (Model Context Protocol) server providing comprehensive email capabilities via IMAP and SMTP.

Enables AI assistants to read, search, send, manage, schedule, and analyze emails across multiple accounts. Exposes 47 tools, 7 prompts, and 6 resources over the MCP protocol with OAuth2 support _(experimental)_, email scheduling, calendar extraction, analytics, provider-aware label management, real-time IMAP IDLE watcher with AI-powered triage, customizable presets and static rules, and a guided setup wizard.

## Highlights

| Feature | email-mcp | Typical MCP email |
|---------|:---------:|:-----------------:|
| Multi-account | ✅ | ❌ |
| Send / reply / forward | ✅ | ✅ |
| Drafts & templates | ✅ | ❌ |
| Labels & bulk ops | ✅ provider-aware | ❌ |
| Schedule future emails | ✅ | ❌ |
| Real-time IMAP IDLE watcher | ✅ | ❌ |
| AI triage with presets | ✅ | ❌ |
| Desktop & webhook alerts | ✅ | ❌ |
| Calendar (ICS) extraction | ✅ | ❌ |
| Email analytics | ✅ | ❌ |
| OAuth2 (Gmail / M365) | ✅ _experimental_ | ❌ |
| Guided setup wizard | ✅ auto-detect | ❌ |

## Table of Contents

- [Highlights](#highlights)
- [Security](#security)
- [Background](#background)
- [Install](#install)
- [Usage](#usage)
- [API](#api)
- [Maintainers](#maintainers)
- [Contributing](#contributing)
- [License](#license)

## Security

- All connections use TLS/STARTTLS encryption
- Passwords are never logged; audit trail records operations without credentials
- Token-bucket rate limiter prevents abuse (configurable per account)
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

Requires Node.js ≥ 22.

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

### Docker

No Node.js required — just Docker.

```bash
# Pull from GitHub Container Registry
docker pull ghcr.io/codefuturist/email-mcp

# Or from Docker Hub
docker pull codefuturist/email-mcp

# Or build from source
docker build -t codefuturist/email-mcp .
```

> **Note:** The server uses stdio transport. Config must be created on the host first
> (via `npx @codefuturist/email-mcp setup` or manually) and mounted into the container.

## Usage

### Setup

```bash
# Add an email account interactively (recommended)
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

**Recommended — use the guided installer** (auto-detects Claude Desktop, VS Code, Cursor, Windsurf):

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

Add to `.vscode/mcp.json` in your workspace, or User `settings.json` under the `mcp` key:

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
<summary><strong>Docker (any MCP client)</strong></summary>

Run the server in a container — mount your config directory read-only:

```bash
docker run --rm -i \
  -v ~/.config/email-mcp:/home/node/.config/email-mcp:ro \
  ghcr.io/codefuturist/email-mcp
```

For MCP client configuration (e.g. Claude Desktop):

```json
{
  "mcpServers": {
    "email": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "-v", "~/.config/email-mcp:/home/node/.config/email-mcp:ro",
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

### CLI Commands

```
email-mcp [command]

Commands:
  stdio                     Run as MCP server over stdio (default)
  account list              List all configured accounts
  account add               Add a new email account interactively
  account edit [name]       Edit an existing account
  account delete [name]     Remove an account
  setup                     Alias for 'account add'
  test                      Test connections for all or a specific account
  install                   Register email-mcp with MCP clients interactively
  install status            Show registration status for detected clients
  install remove            Unregister email-mcp from MCP clients
  config show               Show config (passwords masked)
  config edit               Edit global settings (rate limit, read-only)
  config path               Print config file path
  config init               Create template config
  scheduler check           Process pending scheduled emails
  scheduler list            Show all scheduled emails
  scheduler install         Install OS-level scheduler (launchd/crontab)
  scheduler uninstall       Remove OS-level scheduler
  scheduler status          Show scheduler installation status
  help                      Show help
```

### Configuration

Located at `$XDG_CONFIG_HOME/email-mcp/config.toml` (default: `~/.config/email-mcp/config.toml`).

```toml
[settings]
rate_limit = 10  # max emails per minute per account

[[accounts]]
name = "personal"
email = "you@gmail.com"
full_name = "Your Name"
password = "your-app-password"

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

### Email Scheduling

The scheduler enables future email delivery with a layered architecture:

1. **MCP auto-check** — Processes the queue on server startup and every 60 seconds
2. **CLI** — `email-mcp scheduler check` for manual or cron-based processing
3. **OS-level** — `email-mcp scheduler install` sets up launchd (macOS) or crontab (Linux)

Scheduled emails are stored as JSON files in `~/.local/state/email-mcp/scheduled/` with status-based locking and up to 3 retry attempts.

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
webhook_events = ["urgent", "high"]
```

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

## API

### Tools (47)

#### Read (14)

| Tool | Description |
|------|-------------|
| `list_accounts` | List all configured email accounts |
| `list_mailboxes` | List folders with unread counts and special-use flags |
| `list_emails` | Paginated email listing with date, sender, subject, and flag filters |
| `get_email` | Read full email content with attachment metadata |
| `get_emails` | Fetch full content of multiple emails in a single call (max 20) |
| `get_email_status` | Get read/flag/label state of an email without fetching the body |
| `search_emails` | Search by keyword across subject, sender, and body |
| `download_attachment` | Download an email attachment by filename |
| `find_email_folder` | Discover the real folder(s) an email resides in (resolves virtual folders) |
| `extract_contacts` | Extract unique contacts from recent email headers |
| `get_thread` | Reconstruct a conversation thread via References/In-Reply-To |
| `list_templates` | List available email templates |
| `get_email_stats` | Email analytics — volume, top senders, daily trends |
| `check_health` | Connection health, latency, quota, and IMAP capabilities |

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

#### Calendar & Reminders (6)

| Tool | Description |
|------|-------------|
| `extract_calendar` | Extract ICS/iCalendar events from an email |
| `analyze_email_for_scheduling` | Analyze an email to detect events and reminder-worthy content |
| `add_to_calendar` | Add an email event to the local calendar (macOS/Linux) |
| `create_reminder` | Create a reminder in macOS Reminders.app from an email |
| `list_calendars` | List all available local calendars |
| `check_calendar_permissions` | Check whether the local calendar is accessible |

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
| Templates | `email://templates` | Available email templates |
| Stats | `email://{account}/stats` | Email statistics snapshot |
| Scheduled | `email://scheduled` | Pending scheduled emails |

### Provider Auto-Detection

| Provider | Domains |
|----------|---------|
| Gmail | gmail.com |
| Outlook / Hotmail | outlook.com, hotmail.com, live.com |
| Yahoo Mail | yahoo.com, ymail.com |
| iCloud | icloud.com, me.com, mac.com |
| Fastmail | fastmail.com |
| ProtonMail Bridge | proton.me, protonmail.com |
| Zoho Mail | zoho.com |
| GMX | gmx.com, gmx.de, gmx.net |

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
│   ├── providers.ts       — Provider auto-detection + OAuth2 endpoints (experimental)
│   └── scheduler.ts       — Scheduler CLI
├── config/                — Configuration layer
│   ├── xdg.ts             — XDG Base Directory paths
│   ├── schema.ts          — Zod validation schemas
│   └── loader.ts          — Config loader (TOML + env vars)
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
│   ├── presets.ts         — Built-in hook presets (inbox-zero, gtd, priority-focus, etc.)
│   └── event-bus.ts       — Typed EventEmitter for internal email events
├── tools/                 — MCP tool definitions (42)
├── prompts/               — MCP prompt definitions (7)
├── resources/             — MCP resource definitions (6)
├── safety/                — Audit trail and rate limiter
└── types/                 — Shared TypeScript types
```

## Maintainers

[@codefuturist](https://github.com/codefuturist)

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

## License

[LGPL-3.0-or-later](LICENSE)
