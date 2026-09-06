/**
 * MCP tools: list_templates, apply_template
 *
 * User-defined email templates with {{variable}} substitution.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import audit from '../safety/audit.js';

import type ImapService from '../services/imap.service.js';
import type SmtpService from '../services/smtp.service.js';
import type TemplateService from '../services/template.service.js';
import sentCopyNote from '../utils/sent-copy.js';

export function registerTemplateReadTools(
  server: McpServer,
  templateService: TemplateService,
): void {
  server.tool(
    'list_templates',
    'List all available email templates. Templates are TOML files in ~/.config/email-mcp/templates/ with {{variable}} placeholders for subject and body.',
    {},
    { readOnlyHint: true, destructiveHint: false },
    async () => {
      try {
        const templates = await templateService.listTemplates();

        if (templates.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No templates found. Create .toml files in ${templateService.directory}/ to add templates.\n\nExample template:\n  name = "meeting-followup"\n  description = "Follow-up after a meeting"\n  subject = "Follow-up: {{topic}}"\n  body = "Hi {{name}},\\n\\nThank you for..."\n  variables = ["topic", "name"]`,
              },
            ],
          };
        }

        const lines = templates.map((t) => {
          const vars = t.variables.length > 0 ? ` (variables: ${t.variables.join(', ')})` : '';
          const desc = t.description ? ` — ${t.description}` : '';
          return `📝 ${t.name}${desc}${vars}`;
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: `📋 ${templates.length} template${templates.length === 1 ? '' : 's'} available:\n\n${lines.join('\n')}`,
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to list templates: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );
}

export function registerTemplateWriteTools(
  server: McpServer,
  templateService: TemplateService,
  imapService: ImapService,
  smtpService: SmtpService,
): void {
  server.tool(
    'apply_template',
    'Apply an email template with variable substitution. Use action "preview" to see the result, "draft" to save as draft, or "send" to send immediately.',
    {
      account: z.string().describe('Account name from list_accounts'),
      template: z.string().describe('Template name from list_templates'),
      variables: z
        .record(z.string(), z.string())
        .describe("Variable values as key-value pairs, e.g. { topic: 'Q1 Review' }"),
      action: z
        .enum(['preview', 'draft', 'send'])
        .default('preview')
        .describe('What to do with the composed email'),
      to: z
        .array(z.string())
        .optional()
        .describe('Recipient addresses (required for send, optional for draft)'),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async ({ account, template, variables, action, to }) => {
      try {
        const composed = await templateService.applyTemplate(template, variables);

        if (action === 'preview') {
          return {
            content: [
              {
                type: 'text' as const,
                text: `📝 Template preview — "${template}"\n\nSubject: ${composed.subject}\n\n${composed.body}`,
              },
            ],
          };
        }

        if (action === 'draft') {
          const draftResult = await imapService.saveDraft(account, {
            to: to ?? [],
            subject: composed.subject,
            body: composed.body,
          });

          audit.log(
            'apply_template',
            account,
            {
              template,
              action: 'draft',
            },
            'ok',
          );

          return {
            content: [
              {
                type: 'text' as const,
                text: `✅ Draft saved from template "${template}" (ID: ${draftResult.id} in ${draftResult.mailbox})`,
              },
            ],
          };
        }

        // action === "send"
        if (!to || to.length === 0) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: 'Recipients ("to") are required when action is "send".',
              },
            ],
          };
        }

        const sendResult = await smtpService.sendEmail(account, {
          to,
          subject: composed.subject,
          body: composed.body,
        });

        audit.log(
          'apply_template',
          account,
          {
            template,
            action: 'send',
            to,
          },
          'ok',
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: `✅ Email sent from template "${template}" (Message-ID: ${sendResult.messageId})${sentCopyNote(sendResult)}`,
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to apply template: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );
}
