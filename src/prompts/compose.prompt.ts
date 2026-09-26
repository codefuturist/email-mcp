/**
 * MCP Prompts: compose_reply, draft_from_context
 *
 * AI-assisted email composition with tone control and context awareness.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

export default function registerComposePrompts(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // compose_reply
  // ---------------------------------------------------------------------------
  server.registerPrompt(
    'compose_reply',
    {
      title: 'Compose reply',
      description:
        'Draft a professional reply to an email with tone control. Fetches the original email and optionally the full thread for context.',
      argsSchema: z.object({
        account: z.string().describe('Account name'),
        email_id: z.string().describe('Email ID to reply to (from list_emails)'),
        mailbox: z.string().default('INBOX').describe('Mailbox path (default: INBOX)'),
        intent: z
          .string()
          .describe(
            'What you want to communicate, e.g., "accept the meeting", "decline politely", "request more details"',
          ),
        tone: z
          .enum(['formal', 'friendly', 'brief'])
          .default('friendly')
          .describe('Tone of the reply'),
      }),
    },
    async ({ account, email_id: emailId, mailbox, intent, tone }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Draft a reply to email ID ${emailId} in the "${account}" account.

Follow these steps:
1. Call get_email with account="${account}", emailId="${emailId}", mailbox="${mailbox}" to read the original email.
2. If the email has an inReplyTo or references, optionally call get_thread to understand the full conversation context.
3. Draft a reply with:
   - **Intent:** ${intent}
   - **Tone:** ${tone}
   ${tone === 'formal' ? '   Use professional language, proper salutations, and sign-off.' : ''}
   ${tone === 'friendly' ? '   Use warm but professional language, conversational style.' : ''}
   ${tone === 'brief' ? '   Keep it concise — 2-3 sentences maximum. No unnecessary pleasantries.' : ''}

Output the draft in this format:

## ✉️ Draft Reply

**To:** [Original sender]
**Subject:** Re: [Original subject]

---

[Draft reply body]

---

**Actions:**
- To send this reply, call reply_email with the appropriate parameters.
- To save as draft first, call save_draft.
- If you'd like me to adjust the tone or content, let me know.`,
          },
        },
      ],
    }),
  );

  // ---------------------------------------------------------------------------
  // draft_from_context
  // ---------------------------------------------------------------------------
  server.registerPrompt(
    'draft_from_context',
    {
      title: 'Draft from context',
      description:
        'Compose a new email about a topic, searching past emails for relevant context to reference naturally.',
      argsSchema: z.object({
        account: z.string().describe('Account name'),
        topic: z
          .string()
          .describe(
            'Topic or purpose of the email, e.g., "project status update", "schedule a meeting"',
          ),
        to: z.string().describe('Recipient email address(es), comma-separated'),
        tone: z
          .enum(['formal', 'friendly', 'brief'])
          .default('friendly')
          .describe('Tone of the email'),
      }),
    },
    async ({ account, topic, to, tone }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Compose a new email about "${topic}" to ${to} from the "${account}" account.

Follow these steps:
1. Call search_emails with account="${account}", query="${topic}" to find relevant past emails.
2. If relevant emails are found, call get_email on the most relevant 1-2 to understand the context.
3. Draft a new email that:
   - Addresses the topic: ${topic}
   - References past conversations naturally (if found), e.g., "Following up on our discussion about..."
   - Uses a ${tone} tone
   - Is well-structured with clear purpose and any necessary call-to-action

Output the draft in this format:

## ✉️ New Email Draft

**To:** ${to}
**Subject:** [Suggested subject line]

---

[Draft email body]

---

**Context Used:**
- [Brief note about which past emails were referenced, if any]

**Actions:**
- To send: call send_email with the draft content.
- To save as draft: call save_draft.
- To adjust: let me know what to change.`,
          },
        },
      ],
    }),
  );
}
