/**
 * MCP Resource: email://templates/{name}
 *
 * Dynamic resource exposing user-defined email templates.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { ResourceTemplate } from '@modelcontextprotocol/server';

import type TemplateService from '../services/template.service.js';

export default function registerTemplatesResource(
  server: McpServer,
  templateService: TemplateService,
): void {
  server.registerResource(
    'templates',
    new ResourceTemplate('email://templates/{name}', {
      list: async () => {
        const templates = await templateService.listTemplates();
        return {
          resources: templates.map((t) => ({
            uri: `email://templates/${t.name}`,
            name: `Template: ${t.name}`,
            description: t.description ?? `Email template "${t.name}"`,
            mimeType: 'application/json',
          })),
        };
      },
    }),
    { description: 'User-defined email template with variable placeholders' },
    async (uri, { name }) => {
      const templateName = name as string;
      const template = await templateService.getTemplate(templateName);

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(template, null, 2),
          },
        ],
      };
    },
  );
}
