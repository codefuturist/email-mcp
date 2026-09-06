---
name: email-newsletter-cleanup
description: >-
  Audit newsletter subscriptions via email-mcp: inventory senders by volume,
  surface unsubscribe links for the user to act on, and file or clear the
  backlog.
metadata:
  version: 1.0.0
  requires:
    skills:
      - email-mcp
    mcp:
      - email-mcp
---

# Recipe: Newsletter Cleanup

Find out which subscriptions are actually costing the user attention, and clear
the backlog they have accumulated.

**Prerequisite:** the `email-mcp` base skill.

## What this recipe cannot do, and must say so

email-mcp has no unsubscribe action, no sender blocking, and no per-sender
summarisation. It reports the unsubscribe URI the sender published; **acting on
it is the user's decision and the user's click.** Never open one yourself — it
confirms a live address to whoever sent it, and it is an outward-facing action
nobody authorised.

What this recipe genuinely delivers: an accurate inventory, the links, and the
cleanup of what has already piled up.

## Steps

### Step 1: Inventory the senders

```
list_emails { "account": "perso", "mailbox": "INBOX", "pageSize": 100 }
```

Every list-originated message carries 📰 with its unsubscribe URI. Group the
results by sender and count them. Report volume, because volume is what makes a
subscription worth cancelling:

```
Newsletters in INBOX (100 most recent)
  news@thesequence.io      14 messages · unsub 1-click
  digest@hackernewsletter  9 messages  · unsub 1-click
  hello@somestartup.com    2 messages  · unsub (mailto only)
```

Widen the window with `get_email_stats` when the user wants a monthly picture
rather than a snapshot:

```
get_email_stats { "account": "perso", "period": "month", "mailbox": "INBOX" }
```

### Step 2: Ask before deciding anything

Present the inventory and ask which senders the user actually reads. Do not
infer that a high count means unwanted — a daily newsletter they love outranks a
monthly one they ignore. Do not infer that a low count means dormant.

### Step 3: Hand over the unsubscribe links

For the senders being dropped, list the URIs from the markers:

```
To unsubscribe (open these yourself):
  news@thesequence.io      https://thesequence.io/u/abc123      1-click
  hello@somestartup.com    mailto:unsub-9f2@somestartup.com
```

A `mailto:` target can be actioned from within email-mcp, but only with explicit
approval, because it sends mail on the user's behalf:

```
send_email { "account": "perso", "to": ["unsub-9f2@somestartup.com"], "subject": "unsubscribe", "body": "" }
```

Confirm the exact recipient with the user before sending. Never send in a loop
across several senders off one blanket approval.

### Step 4: Clear the backlog

Once decisions are made, deal with what has accumulated. Archive rather than
delete unless the user asks otherwise:

```
bulk_action { "account": "perso", "mailbox": "INBOX", "action": "move", "ids": ["101","102"], "destination": "Archive" }
```

Up to 100 ids per call. For a larger backlog, page through and confirm the total
with the user before starting — "this will move 340 messages" is information they
need before the first call, not after.

### Step 5: File the keepers

For subscriptions worth keeping but not worth an inbox slot, label them so they
can be read in a batch:

```
create_label { "account": "perso", "name": "Newsletters" }
add_label    { "account": "perso", "emailId": "101", "mailbox": "INBOX", "label": "Newsletters" }
```

One call per message — `bulk_action` cannot apply labels.

To make it stick for future mail, point the user at static hook rules, which are
the closest thing to a filter this server has:

```toml
[[settings.hooks.rules]]
match = { from = "news@thesequence.io|digest@hackernewsletter.com" }
actions = { labels = ["Newsletters"], mark_read = true }
```

`get_hooks_config` shows the current rules. Editing them is a config change, so
show the user the block rather than assuming.

## Tips

- Run against `pageSize: 100` and one account at a time. The inventory is only
  as good as the window you looked at, so say which window you used.
- A sender with no 📰 marker is not a newsletter, whatever the subject looks
  like. Do not add it to the list because it reads like marketing.
- `1-click` means the sender supports RFC 8058 one-click unsubscribe — those are
  the low-friction ones, worth surfacing first.
- Monthly is a sensible cadence. Offer to note it as a reminder rather than
  assuming the user will remember.
