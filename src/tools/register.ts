/**
 * Tool registration — single wiring point.
 *
 * Registers all MCP tools with the server instance.
 * In read-only mode, write tools are not registered at all.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type ConnectionManager from '../connections/manager.js';
import type CalendarService from '../services/calendar.service.js';
import type HooksService from '../services/hooks.service.js';
import type ImapService from '../services/imap.service.js';
import type LocalCalendarService from '../services/local-calendar.service.js';
import type SchedulerService from '../services/scheduler.service.js';
import type SmtpService from '../services/smtp.service.js';
import type TemplateService from '../services/template.service.js';
import type WatcherService from '../services/watcher.service.js';
import type { AppConfig } from '../types/index.js';
import registerAccountsTools from './accounts.tool.js';
import registerAnalyticsTools from './analytics.tool.js';
import registerAttachmentTools from './attachments.tool.js';
import registerBulkTools from './bulk.tool.js';
import registerCalendarTools from './calendar.tool.js';
import registerContactsTools from './contacts.tool.js';
import registerDraftTools from './drafts.tool.js';
import registerEmailsTools from './emails.tool.js';
import registerFolderTools from './folders.tool.js';
import registerHealthTools from './health.tool.js';
import registerLabelTools from './label.tool.js';
import registerLocateTools from './locate.tool.js';
import registerMailboxesTools from './mailboxes.tool.js';
import registerManageTools from './manage.tool.js';
import registerSchedulerTools from './scheduler.tool.js';
import registerSendTools from './send.tool.js';
import { registerTemplateReadTools, registerTemplateWriteTools } from './templates.tool.js';
import registerThreadTools from './thread.tool.js';
import registerWatcherTools from './watcher.tool.js';

export default function registerAllTools(
  server: McpServer,
  connections: ConnectionManager,
  imapService: ImapService,
  smtpService: SmtpService,
  config: AppConfig,
  templateService: TemplateService,
  calendarService: CalendarService,
  localCalendarService: LocalCalendarService,
  schedulerService: SchedulerService,
  watcherService: WatcherService,
  hooksService: HooksService,
): void {
  const { readOnly } = config.settings;

  // Read tools — always registered
  registerAccountsTools(server, connections);
  registerMailboxesTools(server, imapService);
  registerEmailsTools(server, imapService);
  registerAttachmentTools(server, imapService);
  registerContactsTools(server, imapService);
  registerThreadTools(server, imapService);
  registerTemplateReadTools(server, templateService);
  registerCalendarTools(server, imapService, calendarService, localCalendarService);
  registerAnalyticsTools(server, imapService);
  registerHealthTools(server, connections, imapService);
  registerLocateTools(server, imapService);
  registerWatcherTools(server, watcherService, hooksService);

  // Write tools — skipped in read-only mode
  if (!readOnly) {
    registerSendTools(server, smtpService);
    registerManageTools(server, imapService);
    registerLabelTools(server, imapService);
    registerBulkTools(server, imapService);
    registerDraftTools(server, imapService, smtpService);
    registerFolderTools(server, imapService);
    registerTemplateWriteTools(server, templateService, imapService, smtpService);
    registerSchedulerTools(server, schedulerService);
  }
}
