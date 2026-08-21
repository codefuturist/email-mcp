/**
 * Resource registration — single wiring point.
 *
 * Registers all MCP resources with the server instance.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import type ConnectionManager from '../connections/manager.js';
import type ImapService from '../services/imap.service.js';
import type SchedulerService from '../services/scheduler.service.js';
import type TemplateService from '../services/template.service.js';
import registerAccountsResource from './accounts.resource.js';
import registerMailboxesResource from './mailboxes.resource.js';
import registerScheduledResource from './scheduled.resource.js';
import registerStatsResource from './stats.resource.js';
import registerTemplatesResource from './templates.resource.js';
import registerUnreadResource from './unread.resource.js';

export default function registerAllResources(
  server: McpServer,
  connections: ConnectionManager,
  imapService: ImapService,
  templateService: TemplateService,
  schedulerService: SchedulerService,
): void {
  registerAccountsResource(server, connections);
  registerMailboxesResource(server, connections, imapService);
  registerUnreadResource(server, connections, imapService);
  registerTemplatesResource(server, templateService);
  registerStatsResource(server, connections, imapService);
  registerScheduledResource(server, schedulerService);
}
