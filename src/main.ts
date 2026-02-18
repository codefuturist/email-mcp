#!/usr/bin/env node
/**
 * Email MCP Server — Main entry point.
 *
 * Subcommands:
 *   stdio     Run as MCP server over stdio (default)
 *   setup     Interactive account setup wizard
 *   test      Test IMAP/SMTP connections
 *   config    Config management (show, path, init)
 *   scheduler Email scheduling management
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadConfig } from './config/loader.js';
import ConnectionManager from './connections/manager.js';
import { bindServer, mcpLog } from './logging.js';
import registerAllPrompts from './prompts/register.js';
import registerAllResources from './resources/register.js';
import RateLimiter from './safety/rate-limiter.js';
import createServer, { PKG_VERSION } from './server.js';
import CalendarService from './services/calendar.service.js';
import HooksService from './services/hooks.service.js';
import ImapService from './services/imap.service.js';
import LocalCalendarService from './services/local-calendar.service.js';
import OAuthService from './services/oauth.service.js';
import SchedulerService from './services/scheduler.service.js';
import SmtpService from './services/smtp.service.js';
import TemplateService from './services/template.service.js';
import WatcherService from './services/watcher.service.js';
import registerAllTools from './tools/register.js';

const HELP = `
email-mcp — Email MCP Server (IMAP + SMTP)

Usage:
  email-mcp [command]

Commands:
  stdio       Run as MCP server over stdio (default)
  account     Account management (list, add, edit, delete)
  setup       Alias for 'account add'
  test        Test connections for all or a specific account
  install     Register/unregister with MCP clients (Claude, Cursor, …)
  config      Config management (show, edit, path, init)
  scheduler   Email scheduling management (check, list, install, uninstall, status)
  notify      Test and diagnose desktop notifications
  help        Show this help message

Examples:
  email-mcp                         # Start MCP server
  email-mcp account list             # List configured accounts
  email-mcp account add              # Add a new email account
  email-mcp account edit personal    # Edit an account
  email-mcp account delete work      # Delete an account
  email-mcp setup                    # Alias for account add
  email-mcp test                     # Test all accounts
  email-mcp test personal            # Test specific account
  email-mcp install                  # Register with detected MCP clients
  email-mcp install status           # Show client registration status
  email-mcp install remove           # Unregister from MCP clients
  email-mcp config show              # Show config (passwords masked)
  email-mcp config edit              # Edit global settings
  email-mcp config path              # Print config file path
  email-mcp config init              # Create template config
  email-mcp scheduler check          # Send overdue scheduled emails
  email-mcp scheduler install        # Install OS periodic check
  email-mcp notify test              # Send a test notification
  email-mcp notify status            # Check notification platform support
`.trim();

async function runServer(): Promise<void> {
  const config = await loadConfig();

  const oauthService = new OAuthService();
  const connections = new ConnectionManager(config.accounts, oauthService);
  const rateLimiter = new RateLimiter(config.settings.rateLimit);
  const imapService = new ImapService(connections);
  const smtpService = new SmtpService(connections, rateLimiter, imapService);
  const templateService = new TemplateService();
  const calendarService = new CalendarService();
  const localCalendarService = new LocalCalendarService();
  const schedulerService = new SchedulerService(smtpService, imapService);
  const watcherService = new WatcherService(config.settings.watcher, config.accounts);
  const hooksService = new HooksService(config.settings.hooks, imapService);

  const server = createServer();
  bindServer(server);

  registerAllTools(
    server,
    connections,
    imapService,
    smtpService,
    config,
    templateService,
    calendarService,
    localCalendarService,
    schedulerService,
    watcherService,
    hooksService,
  );
  registerAllResources(server, connections, imapService, templateService, schedulerService);
  registerAllPrompts(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Start watcher + hooks after connection so we have access to the low-level server
  const lowLevelServer = server.server;
  const clientCaps = lowLevelServer.getClientCapabilities?.() ?? {};
  hooksService.start(lowLevelServer, { sampling: clientCaps.sampling != null });

  await watcherService.start();

  await mcpLog('info', 'server', 'Email MCP server started');

  // Check for overdue scheduled emails on startup
  try {
    const result = await schedulerService.checkAndSend();
    if (result.sent > 0) {
      await mcpLog('info', 'scheduler', `Sent ${result.sent} overdue email(s) on startup`);
    }
  } catch {
    // Non-fatal: scheduler check failure shouldn't prevent server start
  }

  // Periodic scheduler check every 60 seconds
  const checkInterval = setInterval(async () => {
    try {
      await schedulerService.checkAndSend();
    } catch {
      // Silent — don't spam logs
    }
  }, 60_000);

  // Graceful shutdown
  const shutdown = async () => {
    clearInterval(checkInterval);
    hooksService.stop();
    await watcherService.stop();
    await connections.closeAll();
    await server.close();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'stdio';

  switch (command) {
    case 'stdio':
      await runServer();
      break;

    case 'setup': {
      const { default: runSetup } = await import('./cli/setup.js');
      await runSetup();
      break;
    }

    case 'account': {
      const { default: runAccountCommand } = await import('./cli/account-commands.js');
      await runAccountCommand(process.argv[3], process.argv[4]);
      break;
    }

    case 'test': {
      const { default: runTest } = await import('./cli/test.js');
      await runTest(process.argv[3]);
      break;
    }

    case 'config': {
      const { default: runConfigCommand } = await import('./cli/config-commands.js');
      await runConfigCommand(process.argv[3]);
      break;
    }

    case 'install': {
      const { default: runInstallCommand } = await import('./cli/install-commands.js');
      await runInstallCommand(process.argv[3]);
      break;
    }

    case 'scheduler': {
      const { default: runSchedulerCommand } = await import('./cli/scheduler.js');
      await runSchedulerCommand(process.argv[3]);
      break;
    }

    case 'notify': {
      const { default: runNotifyCommand } = await import('./cli/notify.js');
      await runNotifyCommand(process.argv[3]);
      break;
    }

    case '--version':
    case '-v':
      console.log(PKG_VERSION);
      break;

    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      break;

    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
