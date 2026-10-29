/**
 * Application composition root.
 *
 * Builds the service graph (`buildServices`) and a fully-registered McpServer
 * (`buildServer`) from it. Shared by every transport entry point (stdio and
 * Streamable HTTP) so tools/resources/prompts are wired in exactly one place.
 */

import type { McpServer, Server } from '@modelcontextprotocol/server';

import BlobStore from './cache/blob-store.js';
import { collectOrphans, enforceBudget } from './cache/maintenance.js';
import CacheStore from './cache/store.js';
import SyncEngine from './cache/sync-engine.js';
import { loadConfig } from './config/loader.js';
import { CACHE_BLOBS_DIR, CACHE_DB } from './config/xdg.js';
import ConnectionManager from './connections/manager.js';
import { mcpLog } from './logging.js';
import registerAllPrompts from './prompts/register.js';
import registerAllResources from './resources/register.js';
import RateLimiter from './safety/rate-limiter.js';
import createServer from './server.js';
import CalendarService from './services/calendar.service.js';
import ClipboardService from './services/clipboard.service.js';
import CredentialAlertService from './services/credential-alert.service.js';
import DialogService from './services/dialog.service.js';
import HooksService from './services/hooks.service.js';
import ImapService from './services/imap.service.js';
import LocalCalendarService from './services/local-calendar.service.js';
import MailReadService from './services/mail-read.service.js';
import OAuthService from './services/oauth.service.js';
import RemindersService from './services/reminders.service.js';
import SchedulerService from './services/scheduler.service.js';
import SmtpService from './services/smtp.service.js';
import TemplateService from './services/template.service.js';
import VerificationCatcherService from './services/verification-catcher.service.js';
import WatcherService from './services/watcher.service.js';
import registerAllTools from './tools/register.js';
import type { AppConfig } from './types/index.js';

/** The full, shared service graph for one server process. */
export interface AppServices {
  config: AppConfig;
  connections: ConnectionManager;
  imapService: ImapService;
  /** Read-model facade — every read tool goes through this, never ImapService. */
  mailReadService: MailReadService;
  smtpService: SmtpService;
  templateService: TemplateService;
  calendarService: CalendarService;
  localCalendarService: LocalCalendarService;
  remindersService: RemindersService;
  schedulerService: SchedulerService;
  watcherService: WatcherService;
  hooksService: HooksService;
  clipboardService: ClipboardService;
  dialogService: DialogService;
  verificationCatcher: VerificationCatcherService;
  /** Absent when the local mirror is disabled in config. */
  cacheStore?: CacheStore;
  syncEngine?: SyncEngine;
  blobStore?: BlobStore;
}

/** Construct the full service graph from persisted configuration. */
export async function buildServices(): Promise<AppServices> {
  const config = await loadConfig();

  const oauthService = new OAuthService();
  const connections = new ConnectionManager(config.accounts, oauthService);
  const rateLimiter = new RateLimiter(config.settings.rateLimit);
  const imapService = new ImapService(connections);

  // The mirror is optional and must never block startup: if SQLite cannot be
  // opened (read-only volume, corrupt file, unwritable XDG dir) the server
  // still serves every tool live.
  let cacheStore: CacheStore | undefined;
  let syncEngine: SyncEngine | undefined;
  let blobStore: BlobStore | undefined;
  if (config.settings.cache.enabled) {
    try {
      cacheStore = new CacheStore(CACHE_DB);
      syncEngine = new SyncEngine(connections, cacheStore, {
        windowDays: config.settings.cache.windowDays,
        bodyMessages: config.settings.cache.bodyMessages,
        maxSizeMb: config.settings.cache.maxSizeMb,
      });
      imapService.setCacheStore(cacheStore);
      blobStore = new BlobStore(CACHE_BLOBS_DIR);
    } catch (err) {
      cacheStore = undefined;
      syncEngine = undefined;
      blobStore = undefined;
      await mcpLog(
        'warning',
        'cache',
        `Local mirror disabled — could not open ${CACHE_DB}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const mailReadService = new MailReadService(imapService, cacheStore, syncEngine, {}, blobStore);
  const smtpService = new SmtpService(connections, rateLimiter, imapService, {
    saveToSent: config.settings.send.saveToSent,
  });
  const templateService = new TemplateService();
  const calendarService = new CalendarService();
  const localCalendarService = new LocalCalendarService();
  const remindersService = new RemindersService();
  const schedulerService = new SchedulerService(smtpService, imapService, {
    sentRetentionDays: config.settings.scheduler.sentRetentionDays,
  });
  const hooksService = new HooksService(config.settings.hooks, imapService, {
    autoDownloadAttachments: config.settings.attachments.autoDownload,
  });
  // A rejected credential is the one failure that never fixes itself, so the
  // watcher announces it on the desktop — through the hooks notifier, behind
  // the same per-minute rate limit as every other desktop alert.
  const credentialAlerts = new CredentialAlertService(hooksService.getNotifier());
  const watcherService = new WatcherService(
    config.settings.watcher,
    config.accounts,
    oauthService,
    credentialAlerts,
  );
  const clipboardService = new ClipboardService();
  const dialogService = new DialogService();
  // Shares the hooks notifier so desktop notifications from both features
  // sit behind one rate limit (and one lifecycle — hooks owns stop()).
  const verificationCatcher = new VerificationCatcherService(
    config.settings.verification,
    imapService,
    hooksService.getNotifier(),
    clipboardService,
    dialogService,
  );

  return {
    config,
    connections,
    imapService,
    mailReadService,
    smtpService,
    templateService,
    calendarService,
    localCalendarService,
    remindersService,
    schedulerService,
    watcherService,
    hooksService,
    clipboardService,
    dialogService,
    verificationCatcher,
    cacheStore,
    syncEngine,
    blobStore,
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

  registerAllTools(server, services);
  registerAllResources(server, services);
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
  const {
    hooksService,
    watcherService,
    schedulerService,
    imapService,
    syncEngine,
    cacheStore,
    blobStore,
    verificationCatcher,
    config,
  } = services;
  let schedulerInterval: ReturnType<typeof setInterval> | undefined;
  let cacheInterval: ReturnType<typeof setInterval> | undefined;

  hooksService.start(lowLevelServer);
  verificationCatcher.start();
  syncEngine?.start();

  if (config.settings.verification.enabled && !config.settings.watcher.enabled) {
    mcpLog(
      'info',
      'verification',
      'Verification catching is enabled but [settings.watcher] is off — ambient auto-copy is ' +
        'inactive. Enable the watcher for instant catching; get_verification_code works either way.',
    ).catch(() => {});
  }

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
        const { mailboxes, syncInterval, maxSizeMb, windowDays } = config.settings.cache;
        // Orphan reconciliation is cheap but not free (it walks the blob
        // directory), so it rides every twelfth cycle rather than each one.
        const GC_EVERY_CYCLES = 12;
        let cycle = 0;

        const reconcile = async (): Promise<void> => {
          const work = services.connections.getAccountNames().flatMap((account) =>
            mailboxes.map(async (mailbox) => {
              await syncEngine.syncMailbox(account, mailbox);
              // Body backfill rides the same cycle; neither call ever throws.
              await syncEngine.backfillBodies(account, mailbox);
            }),
          );
          await Promise.allSettled(work);

          // Maintenance after the sync burst: enforce the byte budget, hand
          // freed pages back, and truncate the WAL while things are idle.
          if (cacheStore && blobStore) {
            cycle += 1;
            try {
              await enforceBudget(cacheStore, blobStore, maxSizeMb, { windowDays });
              if (cycle % GC_EVERY_CYCLES === 1) {
                await collectOrphans(cacheStore, blobStore);
              }
              cacheStore.checkpoint();
            } catch (err) {
              await mcpLog(
                'warning',
                'cache',
                `Cache maintenance failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
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
      // Before hooksService.stop() — hooks owns the shared notifier interval.
      verificationCatcher.stop();
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
