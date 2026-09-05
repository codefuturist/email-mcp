---
name: email-label-organize
description: >-
  Organize mail with IMAP labels and folders via email-mcp: apply project
  labels, remove wrong ones, and move misfiled messages to the right folder.
metadata:
  version: 1.0.0
  requires:
    mcp:
      - email-mcp
---

# Recipe: Label & Folder Organize

Organize mail using IMAP keywords (labels) and folders. Apply project labels,
strip incorrect ones, and move misfiled messages.

## Before you start

Three things about `email-mcp` differ from other mail tools and will cause
silent mistakes if you assume otherwise:

- **`account` is a config name, not an address.** It is the `name` field of an
  account in `config.toml` (e.g. `perso`), never `you@example.com`. Always call
  `list_accounts` first and use the names it returns.
- **`account` and `mailbox` are separate parameters.** There is no qualified
  `account:Folder` syntax; pass `{ "account": "perso", "mailbox": "Projects" }`.
- **`bulk_action` cannot apply labels.** It supports only `mark_read`,
  `mark_unread`, `flag`, `unflag`, `move` and `delete`, with at most 100 ids.
  Labelling several messages means calling `add_label` once per message.

## Steps

### Step 1: Discover accounts, folders and existing labels

```
list_accounts {}
list_mailboxes { "account": "perso" }
list_labels    { "account": "perso" }
```

Note which labels already exist. Reuse an existing label rather than creating a
near-duplicate — `Project-Alpha` and `ProjectAlpha` will both stick around and
split the same conversation across two labels.

### Step 2: Find the messages to organize

```
search_emails { "account": "perso", "query": "project alpha", "pageSize": 50 }
list_emails   { "account": "perso", "from": "client@company.com", "since": "2026-08-01" }
```

`list_emails` filters structurally (`from`, `subject`, `since`, `before`,
`seen`, `flagged`, `has_attachment`, `answered`). `search_emails` adds
full-text `query`, plus `to`, `larger_than` and `smaller_than`. Both are
paginated — raise `pageSize` rather than walking pages one by one.

Keep the returned UIDs: every action below needs them.

### Step 3: Create the label if it does not exist

```
create_label { "account": "perso", "name": "ProjectAlpha" }
```

Skip this when `list_labels` already showed it.

### Step 4: Apply the label

`add_label` is non-destructive — the message keeps its current folder.

```
add_label { "account": "perso", "emailId": "12345", "mailbox": "INBOX", "label": "ProjectAlpha" }
```

`mailbox` must be the folder the message actually lives in. If a message was
found through a search that spans folders, confirm its location first:

```
find_email_folder { "account": "perso", "emailId": "12345", "sourceMailbox": "INBOX" }
```

For several messages, repeat the call per UID. There is no batch form.

### Step 5: Remove an incorrect label

```
remove_label { "account": "perso", "emailId": "12345", "mailbox": "INBOX", "label": "WrongLabel" }
```

To retire a label everywhere at once:

```
delete_label { "account": "perso", "name": "WrongLabel" }
```

`delete_label` removes the label itself, not the messages. Confirm with the user
before calling it — it affects every message carrying that label.

### Step 6: Move misfiled messages

Moving is destructive in a way labelling is not: the message leaves its folder.

```
move_email { "account": "perso", "emailId": "12345", "sourceMailbox": "INBOX", "destinationMailbox": "Projects" }
```

For up to 100 messages in one call:

```
bulk_action { "account": "perso", "mailbox": "INBOX", "action": "move", "ids": ["12345","12346"], "destination": "Projects" }
```

### Step 7: Verify

```
list_labels { "account": "perso" }
list_emails { "account": "perso", "mailbox": "Projects", "pageSize": 20 }
```

Report what changed: how many messages were labelled, how many moved, and any
that could not be located.

## Label or move?

| Situation | Use |
|---|---|
| Gmail account | `add_label` — Gmail is label-based; moving fights the model |
| Message belongs to several topics | `add_label`, repeatedly |
| Message is in the wrong place outright | `move_email` |
| Emptying the inbox after triage | `move_email` or `bulk_action` with `move` |

## Tips

- Run `list_labels` before every labelling session; labels drift as mail arrives.
- IMAP keyword support varies by server. If `add_label` fails on a provider,
  fall back to folders and `move_email`.
- A label name with spaces or non-ASCII characters is accepted by some servers
  and rejected by others. Prefer `ProjectAlpha` over `Projet Alpha`.
- Never guess a UID. Take it from `list_emails` or `search_emails` in the same
  session — UIDs are per-mailbox and change when a message moves.
