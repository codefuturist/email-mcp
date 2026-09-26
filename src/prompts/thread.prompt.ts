/**
 * MCP Prompt: summarize_thread
 *
 * Instructs the LLM to fetch and summarize an email conversation thread
 * with structured output including participants, decisions, and action items.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

export default function registerThreadPrompt(server: McpServer): void {
  server.registerPrompt(
    'summarize_thread',
    {
      title: 'Summarize thread',
      description:
        'Summarize an email conversation thread. Produces a structured report with participants, timeline, decisions, and action items.',
      argsSchema: z.object({
        account: z.string().describe('Account name'),
        message_id: z.string().describe('Message-ID of any email in the thread (from get_email)'),
        mailbox: z.string().default('INBOX').describe('Mailbox to search (default: INBOX)'),
      }),
    },
    async ({ account, message_id: messageId, mailbox }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Summarize the email thread containing Message-ID: ${messageId}

Follow these steps:
1. Call get_thread with account="${account}", message_id="${messageId}", mailbox="${mailbox}" to fetch the full conversation.
2. Read through all messages in chronological order.
3. Identify key information across the thread.

Output a structured summary in this format:

## 🧵 Thread Summary

**Subject:** [Thread subject]
**Date Range:** [First message date] → [Last message date]
**Messages:** [Count]

### 👥 Participants
- [Name/Email] — [Role in the conversation, e.g., "initiated request", "provided update"]

### 📋 Timeline
1. **[Date]** — [Sender]: [One-line summary of this message's contribution]
2. **[Date]** — [Sender]: [One-line summary]
...

### 🎯 Key Decisions
- [Decision made and by whom]

### ❓ Open Questions
- [Unresolved questions from the thread]

### ✅ Action Items
- [ ] [Action] — assigned to [Person], deadline: [if mentioned]

### 📝 Summary
[2-3 sentence narrative summary of the entire conversation]`,
          },
        },
      ],
    }),
  );
}
