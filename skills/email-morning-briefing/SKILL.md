---
name: email-morning-briefing
description: >-
  Start-of-day briefing from email-mcp: today's calendar, mail that a person
  actually sent, and reminders coming due.
metadata:
  version: 1.0.0
  requires:
    skills:
      - email-mcp
    mcp:
      - email-mcp
---

# Recipe: Morning Briefing

A short, accurate picture of the day. Its value is in what it leaves out.

**Prerequisite:** the `email-mcp` base skill.

## Steps

### Step 1: Today's calendar

```
check_calendar_permissions {}
list_events { "from": "<today 00:00>", "to": "<today 23:59>" }
```

Check permissions first. These read the **local OS calendar**, so a permission
that was never granted returns an empty day rather than an error — reporting
"nothing scheduled" in that case would be wrong.

### Step 2: Mail a person actually sent

Across every configured account, since there is no unified inbox:

```
list_accounts {}
list_emails { "account": "perso", "mailbox": "INBOX", "seen": false, "pageSize": 50 }
```

Keep the messages with **no** bulk marker. Those are the ones a human wrote.
Count the marked ones, do not list them.

### Step 3: What is still waiting on a reply

```
list_emails { "account": "perso", "mailbox": "INBOX", "flagged": true, "answered": false }
```

Flagged and unanswered is the closest thing to a follow-up queue.

### Step 4: Reminders coming due

```
list_reminders { "limit": 20 }
```

### Step 5: Present it

Lead with what needs a decision today, not with inventory:

```
Thursday 6 September

Calendar — 3 meetings
  09:30  Sprint review (45m)
  14:00  1:1 with Sam
  16:30  Vendor call — no agenda attached

Waiting on you — 4
  Sam Ruiz       Re: Q4 budget — asked twice, still unanswered
  accounting@…   Invoice 2291 approval
  …

Reminders due — 1
  Reply to the vendor about pricing

Also: 61 unread across newsletters and automated mail. Say the word and I'll clear it.
```

## Tips

- Keep it short. A briefing that lists 61 newsletters is not a briefing.
- Say when an account failed rather than reporting it as quiet — an expired
  credential and an empty inbox look identical in a count.
- "Asked twice, still unanswered" is worth more than a subject line. Use
  `answered: false` and the thread to say why something matters.
- There is no team view in email-mcp. If the user expects assignment status,
  say it is not available rather than approximating it.
- This pairs naturally with `email-inbox-zero`: brief first, then offer to triage.
