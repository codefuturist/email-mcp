/**
 * MCP Tools: schedule_email, list_scheduled, cancel_scheduled
 *
 * Email scheduling tools for "send later" functionality.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import audit from '../safety/audit.js';

import type SchedulerService from '../services/scheduler.service.js';
import attachmentsSchema from './attachment-input.schema.js';

export default function registerSchedulerTools(
  server: McpServer,
  schedulerService: SchedulerService,
): void {
  // ---------------------------------------------------------------------------
  // schedule_email (write)
  // ---------------------------------------------------------------------------

  server.tool(
    'schedule_email',
    'Schedule an email to be sent at a specific time in the future. Supports file attachments. The email is queued locally and sent automatically when the time arrives.',
    {
      account: z.string().describe('Account name to send from'),
      to: z.array(z.string()).min(1).describe('Recipient email addresses'),
      subject: z.string().describe('Email subject'),
      body: z.string().describe('Email body'),
      send_at: z.string().describe("When to send (ISO 8601 datetime, e.g. '2025-02-20T09:00:00Z')"),
      cc: z.array(z.string()).optional().describe('CC recipients'),
      bcc: z.array(z.string()).optional().describe('BCC recipients'),
      html: z.boolean().default(false).describe('Send as HTML (default: false)'),
      in_reply_to: z.string().optional().describe('Message-ID to reply to'),
      attachments: attachmentsSchema,
    },
    { readOnlyHint: false, destructiveHint: false },
    async (params) => {
      const scheduled = await schedulerService.schedule(params.account, {
        to: params.to,
        subject: params.subject,
        body: params.body,
        sendAt: params.send_at,
        cc: params.cc,
        bcc: params.bcc,
        html: params.html,
        inReplyTo: params.in_reply_to,
        attachments: params.attachments,
      });

      const result = {
        schedule_id: scheduled.id,
        send_at: scheduled.sendAt,
        draft_saved: !!scheduled.draftMessageId,
        status: 'scheduled',
      };

      await audit.log('schedule_email', params.account, params, 'ok');

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // list_scheduled (read)
  // ---------------------------------------------------------------------------

  server.tool(
    'list_scheduled',
    'List scheduled emails. Shows pending, sent, or all scheduled emails.',
    {
      account: z.string().optional().describe('Filter by account name (all accounts if omitted)'),
      status: z
        .enum(['pending', 'sent', 'failed', 'all'])
        .default('pending')
        .describe('Filter by status (default: pending)'),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ account, status }) => {
      const emails = await schedulerService.list({
        account,
        status,
      });

      const summary = emails.map((e) => ({
        id: e.id,
        account: e.account,
        to: e.to.join(', '),
        subject: e.subject,
        send_at: e.sendAt,
        status: e.status,
        attempts: e.attempts,
        overdue: e.status === 'pending' && new Date(e.sendAt).getTime() < Date.now(),
        last_error: e.lastError,
      }));

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ scheduled_emails: summary, count: summary.length }, null, 2),
          },
        ],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // cancel_scheduled (write)
  // ---------------------------------------------------------------------------

  server.tool(
    'cancel_scheduled',
    'Cancel a scheduled email. Removes it from the queue and deletes the associated draft.',
    {
      schedule_id: z.string().describe('Schedule ID to cancel'),
    },
    { readOnlyHint: false, destructiveHint: true },
    async ({ schedule_id: scheduleId }) => {
      const result = await schedulerService.cancel(scheduleId);

      await audit.log('cancel_scheduled', 'system', { scheduleId }, 'ok');

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                cancelled: result.cancelled,
                draft_deleted: result.draftDeleted,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
