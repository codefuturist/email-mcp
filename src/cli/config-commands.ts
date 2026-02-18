/**
 * Config management subcommands.
 *
 * - config show  — display current config with masked passwords
 * - config path  — print config file path
 * - config init  — create a template config file
 */

import fs from 'node:fs/promises';

import { cancel, confirm, intro, isCancel, log, outro, text } from '@clack/prompts';

import {
  CONFIG_FILE,
  configExists,
  generateTemplate,
  loadConfig,
  loadRawConfig,
  saveConfig,
} from '../config/loader.js';

function printConfigUsage(): void {
  console.log(`Usage: email-mcp config <subcommand>

Subcommands:
  show    Show current configuration (passwords masked)
  edit    Edit global settings interactively
  path    Print config file path
  init    Create a template config file
`);
}

function showPath(): void {
  console.log(CONFIG_FILE);
}

async function showConfig(): Promise<void> {
  const exists = await configExists();
  if (!exists) {
    console.error(`No config file found at: ${CONFIG_FILE}`);
    console.error(`Run 'email-mcp setup' or 'email-mcp config init' to create one.`);
    throw new Error('Config file not found');
  }

  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    throw new Error(`Failed to load config: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log(`Config file: ${CONFIG_FILE}\n`);
  console.log(`[settings]`);
  console.log(`  rate_limit = ${config.settings.rateLimit}`);
  console.log(`  read_only  = ${config.settings.readOnly}\n`);

  config.accounts.forEach((account) => {
    console.log(`[accounts.${account.name}]`);
    console.log(`  email    = ${account.email}`);
    if (account.fullName) {
      console.log(`  name     = ${account.fullName}`);
    }
    const smtpSecurity = account.smtp.tls ? 'TLS' : 'plain';
    const smtpLabel = account.smtp.starttls ? 'STARTTLS' : smtpSecurity;
    console.log(
      `  imap     = ${account.imap.host}:${account.imap.port} (${account.imap.tls ? 'TLS' : 'plain'})`,
    );
    console.log(`  smtp     = ${account.smtp.host}:${account.smtp.port} (${smtpLabel})`);
    console.log(`  password = ${'•'.repeat(8)}\n`);
  });
}

async function initConfig(): Promise<void> {
  intro('email-mcp config init');

  const exists = await configExists();
  if (exists) {
    const overwrite = await confirm({
      message: `Config file already exists at ${CONFIG_FILE}. Overwrite?`,
      initialValue: false,
    });

    if (isCancel(overwrite) || !overwrite) {
      cancel('Cancelled.');
      return;
    }
  }

  const dir = CONFIG_FILE.replace(/\/[^/]+$/, '');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(CONFIG_FILE, generateTemplate(), 'utf-8');
  log.success(`Template config created at ${CONFIG_FILE}`);
  log.info("Edit the file to add your email accounts, then run 'email-mcp test'.");
  outro('Done!');
}

async function editSettings(): Promise<void> {
  intro('email-mcp › Edit Settings');

  const exists = await configExists();
  if (!exists) {
    log.error(`No config file found at: ${CONFIG_FILE}`);
    cancel("Run 'email-mcp account add' or 'email-mcp config init' first.");
    return;
  }

  const config = await loadRawConfig();
  const { settings } = config;

  log.info(`Current settings:`);
  log.info(`  rate_limit = ${settings.rate_limit}`);
  log.info(`  read_only  = ${settings.read_only}`);

  const rateLimitStr = await text({
    message: 'Rate limit (max emails per minute per account)',
    defaultValue: String(settings.rate_limit),
    initialValue: String(settings.rate_limit),
    validate: (v) => {
      if (!v) return 'Must be a positive integer';
      const n = parseInt(v, 10);
      if (Number.isNaN(n) || n < 1) return 'Must be a positive integer';
      return undefined;
    },
  });
  if (isCancel(rateLimitStr)) {
    cancel('Cancelled.');
    return;
  }

  const readOnly = await confirm({
    message: 'Read-only mode? (disables all write operations)',
    initialValue: settings.read_only,
  });
  if (isCancel(readOnly)) {
    cancel('Cancelled.');
    return;
  }

  const updatedConfig = {
    ...config,
    settings: {
      rate_limit: parseInt(rateLimitStr, 10),
      read_only: readOnly,
    },
  };

  await saveConfig(updatedConfig);
  log.success(`Settings updated. Config saved to ${CONFIG_FILE}`);
  outro('Done!');
}

export default async function runConfigCommand(subcommand?: string): Promise<void> {
  switch (subcommand) {
    case 'show':
      await showConfig();
      return;
    case 'edit':
      await editSettings();
      return;
    case 'path':
      showPath();
      return;
    case 'init':
      await initConfig();
      return;
    default:
      printConfigUsage();
  }
}
