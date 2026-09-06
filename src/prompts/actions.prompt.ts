/**
 * MCP Prompt: extract_action_items
 *
 * Instructs the LLM to scan recent emails and extract actionable items
 * including tasks, deadlines, commitments, and pending questions.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export default function registerActionsPrompt(server: McpServer): void {
  server.prompt(
    'extract_action_items',
    'Scan recent emails and extract action items, deadlines, and commitments. Produces a structured task list with source references.',
    {
      account: z.string().describe('Account name'),
      mailbox: z.string().default('INBOX').describe('Mailbox to scan (default: INBOX)'),
      limit: z.string().default('20').describe('Number of recent emails to scan (default: 20)'),
    },
    async ({ account, mailbox, limit }) => {
      const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Extract action items from recent emails in the "${mailbox}" mailbox of the "${account}" account.

Follow these steps:
1. Call list_emails with account="${account}", mailbox="${mailbox}", pageSize=${limitNum} to get recent emails.
2. For each email that looks like it might contain action items (based on subject and sender),
   call get_email to read the full content. Emails marked 📰 newsletter or 🤖 automated rarely
   carry action items — skip them unless the subject clearly suggests otherwise.
3. Extract ALL actionable items from the emails.

Look for:
- **Direct requests:** "Please...", "Can you...", "Could you...", "I need..."
- **Deadlines:** Dates, "by end of week", "ASAP", "before the meeting"
- **Commitments you made:** "I will...", "I'll send...", "Let me..."
- **Questions awaiting your response:** Questions directed at you
- **Meeting follow-ups:** Action items from meetings mentioned in emails
- **Approvals needed:** Requests for sign-off or review

Output a structured report in this format:

## ✅ Action Items — ${account}
**Scanned:** [Count] emails from ${mailbox}

### 🔴 Urgent / Has Deadline
- [ ] [Action description] — from [Sender] ([Date])
      📧 Re: [Subject] | ⏰ Deadline: [deadline if mentioned]

### 🟡 Needs Response
- [ ] [Reply to / Answer question about...] — from [Sender] ([Date])
      📧 Re: [Subject]

### 🔵 Tasks / Commitments
- [ ] [Task description] — from [Sender] ([Date])
      📧 Re: [Subject]

### 📊 Summary
- **Total action items:** [count]
- **With deadlines:** [count]
- **Awaiting your response:** [count]
- **Commitments you made:** [count]`,
            },
          },
        ],
      };
    },
  );
}
