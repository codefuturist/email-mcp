#!/usr/bin/env node
/**
 * Email MCP Server — Main entry point.
 *
 * Subcommands:
 *   stdio     Run as MCP server over stdio (default)
 *   http      Run as MCP server over Streamable HTTP (networked)
 *   account   Account management (list, add, edit, delete)
 *   test      Test IMAP/SMTP connections
 *   config    Config management (show, path, init)
 *   scheduler Email scheduling management
 */

import { serveStdio } from '@modelcontextprotocol/server/stdio';

import type { BackgroundHandle } from './app.js';
import { buildServer, buildServices, startBackgroundServices } from './app.js';
import { PKG_VERSION } from './server.js';

const HELP = `
email-mcp — Email MCP Server (IMAP + SMTP)

Usage:
  email-mcp [command]

Commands:
  stdio       Run as MCP server over stdio (default)
  http        Run as MCP server over Streamable HTTP (networked)
  account     Account management (list, add, edit, delete)
  setup       Alias for 'account add'
  test        Test connections for all or a specific account
  install     Register/unregister with MCP clients (Claude, Cursor, …)
  config      Config management (show, edit, path, init)
  scheduler   Email scheduling management (check, list, install, uninstall, status)
  notify      Test and diagnose desktop notifications
  help        Show this help message

Examples:
  email-mcp                         # Start MCP server (stdio)
  email-mcp http --port 8080         # Start Streamable HTTP server on :8080/mcp
  email-mcp http --host 0.0.0.0 --port 8080   # Bind all interfaces (requires a token)
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
  const services = await buildServices();

  let background: BackgroundHandle | undefined;
  let started = false;

  // serveStdio owns the transport: it selects the protocol era from the
  // opening exchange, pins one instance from the factory for the connection,
  // and serves both 2025- and 2026-era clients (legacy shim, default). For
  // stdio there is exactly one connection, so we start the process-level
  // background services the first time the factory builds a server — parity
  // with the old post-`initialized` hook, minus the stateful handshake dance
  // the 2026-07-28 spec removed.
  const handle = serveStdio(() => {
    const server = buildServer(services);
    if (!started) {
      started = true;
      background = startBackgroundServices(services, server.server);
    }
    return server;
  });

  // Graceful shutdown.
  const shutdown = async () => {
    if (background) await background.stop();
    await services.connections.closeAll();
    await handle.close();
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

    case 'http': {
      const { default: runHttp } = await import('./cli/http.js');
      await runHttp(process.argv.slice(3));
      break;
    }

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
