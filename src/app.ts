/**
 * Application composition root.
 *
 * Builds the service graph (`buildServices`) and a fully-registered McpServer
 * (`buildServer`) from it. Shared by every transport entry point (stdio and
 * Streamable HTTP) so tools/resources/prompts are wired in exactly one place.
 */

import type { McpServer, Server } from '@modelcontextprotocol/server';

import CacheStore from './cache/store.js';
import SyncEngine from './cache/sync-engine.js';
import { loadConfig } from './config/loader.js';
import { CACHE_DB } from './config/xdg.js';
import ConnectionManager from './connections/manager.js';
import { mcpLog } from './logging.js';
import registerAllPrompts from './prompts/register.js';
import registerAllResources from './resources/register.js';
import RateLimiter from './safety/rate-limiter.js';
import createServer from './server.js';
import CalendarService from './services/calendar.service.js';
import HooksService from './services/hooks.service.js';
import ImapService from './services/imap.service.js';
import LocalCalendarService from './services/local-calendar.service.js';
import OAuthService from './services/oauth.service.js';
import RemindersService from './services/reminders.service.js';
import SchedulerService from './services/scheduler.service.js';
import SmtpService from './services/smtp.service.js';
import TemplateService from './services/template.service.js';
import WatcherService from './services/watcher.service.js';
import registerAllTools from './tools/register.js';
import type { AppConfig } from './types/index.js';

/** The full, shared service graph for one server process. */
export interface AppServices {
  config: AppConfig;
  connections: ConnectionManager;
  imapService: ImapService;
  smtpService: SmtpService;
  templateService: TemplateService;
  calendarService: CalendarService;
  localCalendarService: LocalCalendarService;
  remindersService: RemindersService;
  schedulerService: SchedulerService;
  watcherService: WatcherService;
  hooksService: HooksService;
  /** Absent when the local mirror is disabled in config. */
  cacheStore?: CacheStore;
  syncEngine?: SyncEngine;
}

/** Construct the full service graph from persisted configuration. */
export async function buildServices(): Promise<AppServices> {
  const config = await loadConfig();

  const oauthService = new OAuthService();
  const connections = new ConnectionManager(config.accounts, oauthService);
  const rateLimiter = new RateLimiter(config.settings.rateLimit);
  const imapService = new ImapService(connections);
  const smtpService = new SmtpService(connections, rateLimiter, imapService);
  const templateService = new TemplateService();
  const calendarService = new CalendarService();
  const localCalendarService = new LocalCalendarService();
  const remindersService = new RemindersService();
  const schedulerService = new SchedulerService(smtpService, imapService);
  const watcherService = new WatcherService(config.settings.watcher, config.accounts);
  const hooksService = new HooksService(config.settings.hooks, imapService);

  // The mirror is optional and must never block startup: if SQLite cannot be
  // opened (read-only volume, corrupt file, unwritable XDG dir) the server
  // still serves every tool live.
  let cacheStore: CacheStore | undefined;
  let syncEngine: SyncEngine | undefined;
  if (config.settings.cache.enabled) {
    try {
      cacheStore = new CacheStore(CACHE_DB);
      syncEngine = new SyncEngine(connections, cacheStore);
    } catch (err) {
      cacheStore = undefined;
      syncEngine = undefined;
      await mcpLog(
        'warning',
        'cache',
        `Local mirror disabled — could not open ${CACHE_DB}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return {
    config,
    connections,
    imapService,
    smtpService,
    templateService,
    calendarService,
    localCalendarService,
    remindersService,
    schedulerService,
    watcherService,
    hooksService,
    cacheStore,
    syncEngine,
  };
}

/**
 * Build a fresh, fully-registered McpServer from an existing service graph.
 *
 * Safe to call per connection (stdio) or per request (stateless HTTP): the
 * services are shared singletons, only the thin protocol wrapper is new.
 */
export function buildServer(services: AppServices): McpServer {
  const server = createServer();

  registerAllTools(
    server,
    services.connections,
    services.imapService,
    services.smtpService,
    services.config,
    services.templateService,
    services.calendarService,
    services.localCalendarService,
    services.remindersService,
    services.schedulerService,
    services.watcherService,
    services.hooksService,
  );
  registerAllResources(
    server,
    services.connections,
    services.imapService,
    services.templateService,
    services.schedulerService,
  );
  registerAllPrompts(server);

  return server;
}

/** Handle for tearing down the process-level background services. */
export interface BackgroundHandle {
  stop: () => Promise<void>;
}

/**
 * Start the process-level background services: the new-mail watcher (feeding
 * AI hooks + resource-update notifications) and the periodic scheduled-email
 * check. These are process-scoped, not per-connection or per-request.
 *
 * @param lowLevelServer the connected low-level `Server` for notifications /
 *   opportunistic sampling, or `null` when no persistent connection applies.
 */
export function startBackgroundServices(
  services: AppServices,
  lowLevelServer: Server | null,
): BackgroundHandle {
  const { hooksService, watcherService, schedulerService, imapService, syncEngine, config } =
    services;
  let schedulerInterval: ReturnType<typeof setInterval> | undefined;
  let cacheInterval: ReturnType<typeof setInterval> | undefined;

  hooksService.start(lowLevelServer);
  syncEngine?.start();

  void (async () => {
    try {
      await watcherService.start();
      await mcpLog('info', 'server', 'Email MCP background services started');

      // Check for overdue scheduled emails on startup.
      try {
        const result = await schedulerService.checkAndSend();
        if (result.sent > 0) {
          await mcpLog('info', 'scheduler', `Sent ${result.sent} overdue email(s) on startup`);
        }
      } catch {
        // Non-fatal: a scheduler check failure shouldn't prevent startup.
      }

      // Periodic scheduler check every 60 seconds.
      schedulerInterval = setInterval(async () => {
        try {
          await schedulerService.checkAndSend();
        } catch {
          // Silent — don't spam logs.
        }
      }, 60_000);

      // Reconcile the local mirror: once at startup, then on an interval.
      // syncMailbox never throws and never blocks a tool call, so this can
      // stay fire-and-forget.
      if (syncEngine) {
        const { mailboxes, syncInterval } = config.settings.cache;
        const reconcile = async (): Promise<void> => {
          const work = services.connections
            .getAccountNames()
            .flatMap((account) =>
              mailboxes.map((mailbox) => syncEngine.syncMailbox(account, mailbox)),
            );
          await Promise.allSettled(work);
        };

        await reconcile();
        cacheInterval = setInterval(() => {
          void reconcile();
        }, syncInterval * 1000);
      }
    } catch (err) {
      process.stderr.write(
        `[email-mcp] background start error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  })();

  return {
    stop: async () => {
      if (schedulerInterval) clearInterval(schedulerInterval);
      if (cacheInterval) clearInterval(cacheInterval);
      hooksService.stop();
      await watcherService.stop();
      syncEngine?.stop();
      imapService.dispose();
      // The mirror commits incrementally under WAL, so closing here is tidy
      // rather than load-bearing — neither shutdown handler is guaranteed to
      // run to completion (main.ts:85, cli/http.ts:175).
      services.cacheStore?.close();
    },
  };
}
