---
name: email-inbox-zero
description: >-
  Work an inbox down to zero with email-mcp, triaging people mail first and
  batching the machine-generated remainder.
metadata:
  version: 1.0.0
  requires:
    skills:
      - email-mcp
    mcp:
      - email-mcp
---

# Recipe: Inbox Zero

Process an inbox in the order that respects attention: what a person wrote,
first; what a machine sent, in bulk, last.

**Prerequisite:** the `email-mcp` base skill.

## The ordering, and why

The 📰 / 🤖 markers split the inbox along the only line that reliably predicts
whether a human is waiting: a person wrote it, or a system emitted it. Work the
unmarked mail first. It is usually a small fraction of the volume and nearly all
of the obligation.

Do **not** start with newsletters because they are easy to clear. Ending with a
tidy inbox and an unanswered colleague is a worse outcome than stopping halfway.

## Steps

### Step 1: See the shape of it

```
list_emails { "account": "perso", "mailbox": "INBOX", "seen": false, "pageSize": 100 }
```

Sort what comes back into three piles and report the counts before touching
anything:

```
Unread in INBOX: 87
  👤 personal      11
  🤖 automated     23
  📰 newsletter    53
```

The user should be able to say "just do the newsletters" before you have spent
their time on the rest.

### Step 2: Work the personal mail one at a time

For each unmarked message, read enough to decide — the thread when there is one:

```
get_thread { "account": "perso", "message_id": "<message-id>", "mailbox": "INBOX", "format": "stripped" }
```

`format: "stripped"` drops quoted chains and signatures, which is most of the
bytes in a long reply chain.

Then pick one:

**Needs a reply now** — draft it, show it, send only once approved:
```
save_draft { "account": "perso", "subject": "Re: …", "body": "…", "in_reply_to": "<message-id>" }
```

**Needs a reply later** — flag it and set a dated reminder. There is no snooze;
this is the honest substitute, and it does not hide the message:
```
mark_email     { "account": "perso", "id": "123", "mailbox": "INBOX", "action": "flag" }
create_reminder { "account": "perso", "email_id": "123", "mailbox": "INBOX", "title": "Reply to …", "due_date": "2026-09-12" }
```

**Needs filing** — move it:
```
move_email { "account": "perso", "emailId": "123", "sourceMailbox": "INBOX", "destinationMailbox": "Projects" }
```

**Done** — archive:
```
move_email { "account": "perso", "emailId": "123", "sourceMailbox": "INBOX", "destinationMailbox": "Archive" }
```

### Step 3: Batch the automated pile

Machine-generated mail rarely needs reading individually. Scan subjects for the
exceptions — a failed payment, an expiring credential, a security alert — pull
those out, then batch the rest:

```
bulk_action { "account": "perso", "mailbox": "INBOX", "action": "move", "ids": ["201","202"], "destination": "Archive" }
```

Confirm the count with the user before the first call. Up to 100 ids each.

### Step 4: Batch the newsletters

Same treatment, lower stakes. If the pile is large and recurring, this is a
signal rather than a chore — offer the `email-newsletter-cleanup` recipe instead
of clearing the same backlog again next week.

### Step 5: Verify and report

```
list_emails { "account": "perso", "mailbox": "INBOX", "seen": false, "pageSize": 100 }
```

Report the real end state, including what you deliberately left:

```
INBOX: 4 unread left
  3 flagged for reply, reminders set for Sep 12
  1 left unread — from your accountant, needs a decision I cannot make for you
```

## Tips

- Archive rather than delete. Deletion is irreversible and buys nothing here;
  reserve `delete_email` for cases the user explicitly asks for.
- Never mark a personal message read to clear a count. Unread is the user's own
  signal, and quietly consuming it destroys information.
- Stop and ask when a message needs a decision only the user can make. An inbox
  at zero that hid a real question is a failure dressed as success.
- On Gmail, moving out of INBOX is what archiving means; `list_mailboxes` shows
  the account's actual Archive folder, which is not always named `Archive`.
