---
name: email-multi-account-review
description: >-
  Review every configured mail account via email-mcp and present a unified
  status summary with a per-account unread and activity breakdown.
metadata:
  version: 1.0.0
  requires:
    mcp:
      - email-mcp
---

# Recipe: Multi-Account Review

Give the user one picture of every mailbox they have configured, without making
them ask account by account.

## Before you start

**There is no unified inbox.** Every `email-mcp` tool takes a single `account`,
so a cross-account view is something you assemble by calling each account in
turn and aggregating the results yourself. Do not present a total you did not
actually compute.

`account` is the account `name` from `config.toml` (e.g. `perso`, `gmail`),
never an email address.

## Steps

### Step 1: Discover the accounts

```
list_accounts {}
```

This is the only tool that needs no `account`. Everything below runs once per
account it returns.

### Step 2: Check reachability before counting

An account whose credentials expired returns errors, not zero — reporting it as
"0 unread" would be wrong and would hide a broken account.

```
check_health {}
```

**Its output is verbose** — it returns the full IMAP capability list for every
account, roughly twenty entries each. Read only `name`, `imap.connected` and
`smtp.connected`; never relay the capability arrays to the user.

Report any unreachable account explicitly and exclude it from the totals rather
than letting it read as an empty inbox.

`auth_type` in this output currently reports `password` for accounts that
resolve their password through `password_command`. Do not present it as the
account's real credential source.

### Step 3: Unread per account

```
list_emails { "account": "perso",     "mailbox": "INBOX", "seen": false, "pageSize": 50 }
list_emails { "account": "gmail",     "mailbox": "INBOX", "seen": false, "pageSize": 50 }
list_emails { "account": "silvestre", "mailbox": "INBOX", "seen": false, "pageSize": 50 }
```

The result is paginated and reports a total — use that total, do not count the
items on page 1 and call it the answer.

### Step 4: Activity and volume

```
get_email_stats { "account": "perso", "period": "week", "mailbox": "INBOX" }
```

`period` accepts `day`, `week` or `month`. This is what separates a genuinely
busy account from one with a large but stale backlog.

### Step 5: Surface what actually needs attention

Unread count alone is a poor signal — a newsletter-heavy account inflates it.
Narrow to what plausibly needs a human:

```
list_emails { "account": "perso", "mailbox": "INBOX", "seen": false, "flagged": true }
list_emails { "account": "perso", "mailbox": "INBOX", "seen": false, "answered": false, "since": "<7 days ago>" }
list_emails { "account": "perso", "mailbox": "INBOX", "from": "<known important sender>", "seen": false }
```

Compute the `since` date yourself from today's date and pass it as ISO 8601.

### Step 6: Folder structure, only when relevant

```
list_mailboxes { "account": "perso" }
```

Worth doing when the user is deciding where to file things, or when an account
has an unusual layout. Skip it for a routine status check — it is noise.

### Step 7: Present the summary

Lead with what needs action, not with the inventory:

```
Needs attention
  perso      3 unread from the last 7 days, none answered
  gmail      1 flagged and unread

Status
  perso      142 unread · 38 received this week
  gmail       12 unread ·  9 received this week
  silvestre    0 unread ·  2 received this week
  hover      unreachable — authentication failed
```

Then offer one concrete next step, such as triaging the busiest account.

## Tips

- Run the per-account calls in parallel; they are independent and the summary is
  only as fast as the slowest one.
- A large unread count on a personal account is usually accumulated newsletters,
  not a backlog. Say so instead of presenting it as urgent.
- When the user works across work and personal contexts, suggest processing them
  in separate passes — mixing them destroys the context they are triaging in.
- If an account fails, report the provider's actual error. `email-mcp` surfaces
  it verbatim, and `535-5.7.8` (bad credentials) needs a very different fix from
  a connection timeout.
- Repeated runs are cheap. Offer to re-run after the user has acted rather than
  keeping a stale summary on screen.
