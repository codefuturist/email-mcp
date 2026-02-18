# Email MCP Server

[![standard-readme compliant](https://img.shields.io/badge/readme%20style-standard-brightgreen.svg?style=flat-square)](https://github.com/RichardLitt/standard-readme)
[![license](https://img.shields.io/github/license/codefuturist/email-mcp.svg?style=flat-square)](LICENSE)

An MCP (Model Context Protocol) server providing comprehensive email capabilities via IMAP and SMTP.

Enables AI assistants to read, search, send, manage, schedule, and analyze emails across multiple accounts. Exposes 29 tools, 7 prompts, and 6 resources over the MCP protocol with OAuth2 support, email scheduling, calendar extraction, analytics, and a guided setup wizard.

## Table of Contents

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
- OAuth2 XOAUTH2 authentication for Gmail and Microsoft 365
- Attachment downloads capped at 5 MB with base64 encoding

## Background

Most MCP email implementations provide only basic read/send. This server aims to be a full-featured email client for AI assistants, covering the entire lifecycle: reading, composing, managing, scheduling, and analyzing email — all from a single MCP server.

Key design decisions:

- **XDG-compliant config** — TOML at `~/.config/email-mcp/config.toml`
- **Multi-account** — Operate across multiple IMAP/SMTP accounts simultaneously
- **Layered services** — Business logic is decoupled from MCP wiring for testability
- **Provider auto-detection** — Gmail, Outlook, Yahoo, iCloud, Fastmail, ProtonMail, Zoho, GMX

## Install

Requires Node.js ≥ 20.

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

## Usage

### Setup

```bash
# Interactive setup (recommended)
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

Using npx:

```json
{
  "mcpServers": {
    "email": {
      "command": "npx",
      "args": ["@codefuturist/email-mcp", "stdio"]
    }
  }
}
```

Or using pnpm:

```json
{
  "mcpServers": {
    "email": {
      "command": "pnpm",
      "args": ["dlx", "@codefuturist/email-mcp", "stdio"]
    }
  }
}
```

For single-account setups without a config file, use environment variables:

```json
{
  "mcpServers": {
    "email": {
      "command": "npx",
      "args": ["@codefuturist/email-mcp", "stdio"],
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

### CLI Commands

```
email-mcp [command]

Commands:
  stdio                Run as MCP server over stdio (default)
  setup                Interactive account setup wizard
  test                 Test connections for all or a specific account
  config show|path|init  Config management
  scheduler check      Process pending scheduled emails
  scheduler list       Show all scheduled emails
  scheduler install    Install OS-level scheduler (launchd/crontab)
  scheduler uninstall  Remove OS-level scheduler
  scheduler status     Show scheduler installation status
  help                 Show help
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
```

#### OAuth2

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
| `MCP_EMAIL_RATE_LIMIT` | `10` | Max sends per minute |

### Email Scheduling

The scheduler enables future email delivery with a layered architecture:

1. **MCP auto-check** — Processes the queue on server startup and every 60 seconds
2. **CLI** — `email-mcp scheduler check` for manual or cron-based processing
3. **OS-level** — `email-mcp scheduler install` sets up launchd (macOS) or crontab (Linux)

Scheduled emails are stored as JSON files in `~/.local/state/email-mcp/scheduled/` with status-based locking and up to 3 retry attempts.

## API

### Tools (28)

#### Read (13)

| Tool | Description |
|------|-------------|
| `list_accounts` | List all configured email accounts |
| `list_mailboxes` | List folders with unread counts and special-use flags |
| `list_emails` | Paginated email listing with date, sender, subject, and flag filters |
| `get_email` | Read full email content with attachment metadata |
| `search_emails` | Search by keyword across subject, sender, and body |
| `download_attachment` | Download an email attachment by filename |
| `find_email_folder` | Discover the real folder(s) an email resides in (resolves virtual folders) |
| `extract_contacts` | Extract unique contacts from recent email headers |
| `get_thread` | Reconstruct a conversation thread via References/In-Reply-To |
| `list_templates` | List available email templates |
| `extract_calendar` | Extract ICS/iCalendar events from an email |
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
│   ├── setup.ts           — Account setup wizard
│   ├── test.ts            — Connection tester
│   ├── config-commands.ts — Config management
│   ├── providers.ts       — Provider auto-detection + OAuth2 endpoints
│   └── scheduler.ts       — Scheduler CLI
├── config/                — Configuration layer
│   ├── xdg.ts             — XDG Base Directory paths
│   ├── schema.ts          — Zod validation schemas
│   └── loader.ts          — Config loader (TOML + env vars)
├── connections/
│   └── manager.ts         — Lazy persistent IMAP/SMTP with OAuth2
├── services/              — Business logic
│   ├── imap.service.ts    — IMAP operations
│   ├── smtp.service.ts    — SMTP operations
│   ├── template.service.ts — Email template engine
│   ├── oauth.service.ts   — OAuth2 token management
│   ├── calendar.service.ts — ICS/iCalendar parsing
│   └── scheduler.service.ts — Email scheduling queue
├── tools/                 — MCP tool definitions (28)
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
