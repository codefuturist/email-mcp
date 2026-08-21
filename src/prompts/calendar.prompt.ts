/**
 * MCP Prompt: summarize_meetings
 *
 * Instructs the LLM to scan recent emails for calendar invites
 * and produce a structured meeting overview.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

export default function registerCalendarPrompt(server: McpServer): void {
  server.registerPrompt(
    'summarize_meetings',
    {
      title: 'Summarize meetings',
      description:
        'Scan recent emails for calendar invites and produce a meeting overview grouped by timeframe.',
      argsSchema: z.object({
        account: z.string().describe('Account name to scan'),
        days: z.string().default('7').describe('Number of days to look back (default: 7)'),
      }),
    },
    async ({ account, days }) => {
      const daysNum = Math.min(Math.max(parseInt(days, 10) || 7, 1), 30);
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Scan the "${account}" account for calendar invitations from the last ${daysNum} days.

Follow these steps:
1. Call search_emails with account="${account}", mailbox="INBOX", since="${new Date(Date.now() - daysNum * 86400000).toISOString().split('T')[0]}" to find recent emails.
2. For each email that might contain a calendar invite (look for subjects with "Meeting", "Invitation", "Calendar", or from calendar systems), call extract_calendar to check for ICS content.
3. Collect all calendar events found.

Then produce a meeting brief in this format:

## 📅 Meeting Brief — ${account}
**Period:** Last ${daysNum} days | **Events found:** [count]

### 📌 Today
- **[Time]** [Summary] — [Location] | 👤 [Organizer] | [Attendee count] attendees
  Status: [CONFIRMED/TENTATIVE/CANCELLED]

### 📆 This Week
- (same format)

### 📆 Next Week
- (same format)

### ⚠️ Conflicts
- [List any overlapping events]

### ❌ Cancelled
- [List any cancelled events]

If no calendar events are found, say "No meeting invitations found in the last ${daysNum} days."`,
            },
          },
        ],
      };
    },
  );
}
