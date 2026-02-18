/**
 * Account management subcommands.
 *
 * - account list          — list all configured accounts
 * - account add           — interactive wizard to add a new account
 * - account edit [name]   — edit an existing account interactively
 * - account delete [name] — remove an account with confirmation
 */

import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  note,
  outro,
  password as p_password,
  spinner as p_spinner,
  select,
  text,
} from '@clack/prompts';

import { CONFIG_FILE, configExists, loadRawConfig, saveConfig } from '../config/loader.js';
import type { RawAccountConfig, RawAppConfig } from '../config/schema.js';
import { AppConfigFileSchema } from '../config/schema.js';
import ConnectionManager from '../connections/manager.js';
import type { AccountConfig } from '../types/index.js';
import ensureInteractive from './guard.js';
import { detectProvider } from './providers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class CancelledError extends Error {
  constructor() {
    super('Operation cancelled.');
  }
}

function assertNotCancel<T>(value: T | symbol): asserts value is T {
  if (isCancel(value)) {
    cancel('Operation cancelled.');
    throw new CancelledError();
  }
}

function formatSecurity(tls: boolean, starttls: boolean): string {
  if (tls) return 'TLS';
  if (starttls) return 'STARTTLS';
  return 'plain';
}

function getSmtpLabel(starttls: boolean, tls: boolean): string {
  if (starttls) return 'STARTTLS';
  if (tls) return 'TLS';
  return 'plain';
}

// ---------------------------------------------------------------------------
// Reusable prompts
// ---------------------------------------------------------------------------

interface ServerSettings {
  imapHost: string;
  imapPort: number;
  imapTls: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpTls: boolean;
  smtpStarttls: boolean;
  smtpPoolEnabled: boolean;
  smtpPoolMaxConnections: number;
  smtpPoolMaxMessages: number;
}

function resolveSmtpSecurityDefault(defaults?: Partial<ServerSettings>): string {
  if (defaults?.smtpStarttls) return 'starttls';
  if (defaults?.smtpTls ?? true) return 'tls';
  return 'none';
}

async function promptServerSettings(defaults?: Partial<ServerSettings>): Promise<ServerSettings> {
  const imapHost = await text({
    message: 'IMAP host',
    placeholder: 'imap.example.com',
    defaultValue: defaults?.imapHost,
    initialValue: defaults?.imapHost,
    validate: (v) => (!v || v.length === 0 ? 'IMAP host is required' : undefined),
  });
  assertNotCancel(imapHost);

  const imapPortStr = await text({
    message: 'IMAP port',
    placeholder: '993',
    defaultValue: String(defaults?.imapPort ?? 993),
    initialValue: defaults?.imapPort ? String(defaults.imapPort) : undefined,
  });
  assertNotCancel(imapPortStr);

  const imapTls = await confirm({
    message: 'IMAP use TLS?',
    initialValue: defaults?.imapTls ?? true,
  });
  assertNotCancel(imapTls);

  const smtpHost = await text({
    message: 'SMTP host',
    placeholder: 'smtp.example.com',
    defaultValue: defaults?.smtpHost,
    initialValue: defaults?.smtpHost,
    validate: (v) => (!v || v.length === 0 ? 'SMTP host is required' : undefined),
  });
  assertNotCancel(smtpHost);

  const smtpPortStr = await text({
    message: 'SMTP port',
    placeholder: '465',
    defaultValue: String(defaults?.smtpPort ?? 465),
    initialValue: defaults?.smtpPort ? String(defaults.smtpPort) : undefined,
  });
  assertNotCancel(smtpPortStr);

  const smtpSecurity = await select({
    message: 'SMTP security',
    initialValue: resolveSmtpSecurityDefault(defaults),
    options: [
      { value: 'tls', label: 'TLS (port 465)' },
      { value: 'starttls', label: 'STARTTLS (port 587)' },
      { value: 'none', label: 'None (not recommended)' },
    ],
  });
  assertNotCancel(smtpSecurity);

  const smtpPoolEnabled = await confirm({
    message: 'Enable SMTP connection pooling?',
    initialValue: defaults?.smtpPoolEnabled ?? true,
  });
  assertNotCancel(smtpPoolEnabled);

  let smtpPoolMaxConnections = defaults?.smtpPoolMaxConnections ?? 1;
  let smtpPoolMaxMessages = defaults?.smtpPoolMaxMessages ?? 100;

  if (smtpPoolEnabled) {
    const maxConnectionsStr = await text({
      message: 'SMTP pool max connections',
      defaultValue: String(defaults?.smtpPoolMaxConnections ?? 1),
      initialValue:
        defaults?.smtpPoolMaxConnections !== undefined
          ? String(defaults.smtpPoolMaxConnections)
          : undefined,
      validate: (v) => {
        if (!v) return 'Must be a positive integer';
        const n = parseInt(v, 10);
        if (Number.isNaN(n) || n < 1) return 'Must be a positive integer';
        return undefined;
      },
    });
    assertNotCancel(maxConnectionsStr);

    const maxMessagesStr = await text({
      message: 'SMTP pool max messages per connection',
      defaultValue: String(defaults?.smtpPoolMaxMessages ?? 100),
      initialValue:
        defaults?.smtpPoolMaxMessages !== undefined
          ? String(defaults.smtpPoolMaxMessages)
          : undefined,
      validate: (v) => {
        if (!v) return 'Must be a positive integer';
        const n = parseInt(v, 10);
        if (Number.isNaN(n) || n < 1) return 'Must be a positive integer';
        return undefined;
      },
    });
    assertNotCancel(maxMessagesStr);

    smtpPoolMaxConnections = parseInt(maxConnectionsStr || '1', 10);
    smtpPoolMaxMessages = parseInt(maxMessagesStr || '100', 10);
  }

  return {
    imapHost,
    imapPort: parseInt(imapPortStr || '993', 10),
    imapTls,
    smtpHost,
    smtpPort: parseInt(smtpPortStr || '465', 10),
    smtpTls: smtpSecurity === 'tls',
    smtpStarttls: smtpSecurity === 'starttls',
    smtpPoolEnabled,
    smtpPoolMaxConnections,
    smtpPoolMaxMessages,
  };
}

/**
 * Prompt for account identity (name, email, full name).
 */
async function promptAccountIdentity(defaults?: {
  name?: string;
  email?: string;
  fullName?: string;
}): Promise<{ name: string; email: string; fullName: string }> {
  const name = await text({
    message: 'Account name',
    placeholder: 'personal',
    defaultValue: defaults?.name,
    initialValue: defaults?.name,
    validate: (v) => (!v || v.length === 0 ? 'Account name is required' : undefined),
  });
  assertNotCancel(name);

  const email = await text({
    message: 'Email address',
    placeholder: 'you@example.com',
    defaultValue: defaults?.email,
    initialValue: defaults?.email,
    validate: (v) => (v?.includes('@') ? undefined : 'Please enter a valid email address'),
  });
  assertNotCancel(email);

  const fullName = await text({
    message: 'Full name (optional)',
    placeholder: 'Your Name',
    defaultValue: defaults?.fullName,
    initialValue: defaults?.fullName,
  });
  assertNotCancel(fullName);

  return { name, email, fullName };
}

/**
 * Prompt for credentials (username, password).
 */
async function promptCredentials(defaults?: {
  username?: string;
  email?: string;
}): Promise<{ username: string; password: string }> {
  const username = await text({
    message: 'Username',
    placeholder: defaults?.email ?? 'you@example.com',
    defaultValue: defaults?.username ?? defaults?.email,
    initialValue: defaults?.username ?? defaults?.email,
  });
  assertNotCancel(username);

  const password = await p_password({
    message: 'Password / App Password',
    validate: (v) => (!v || v.length === 0 ? 'Password is required' : undefined),
  });
  assertNotCancel(password);

  return { username, password };
}

/**
 * Auto-detect provider settings from email domain.
 * Returns server settings or prompts for manual entry.
 */
async function resolveServerSettings(
  email: string,
  defaults?: Partial<ServerSettings>,
): Promise<ServerSettings> {
  const provider = detectProvider(email);

  if (provider) {
    log.success(`Auto-detected: ${provider.name}`);
    log.info(
      `  IMAP: ${provider.imap.host}:${provider.imap.port} (${provider.imap.tls ? 'TLS' : 'plain'})`,
    );
    const smtpLabel = getSmtpLabel(provider.smtp.starttls, provider.smtp.tls);
    log.info(`  SMTP: ${provider.smtp.host}:${provider.smtp.port} (${smtpLabel})`);

    if (provider.notes) {
      log.warning(`  Note: ${provider.notes}`);
    }

    const useDetected = await confirm({
      message: 'Use detected settings?',
      initialValue: true,
    });
    assertNotCancel(useDetected);

    if (useDetected) {
      return {
        imapHost: provider.imap.host,
        imapPort: provider.imap.port,
        imapTls: provider.imap.tls,
        smtpHost: provider.smtp.host,
        smtpPort: provider.smtp.port,
        smtpTls: provider.smtp.tls,
        smtpStarttls: provider.smtp.starttls,
        smtpPoolEnabled: true,
        smtpPoolMaxConnections: 1,
        smtpPoolMaxMessages: 100,
      };
    }
  } else {
    log.info('Provider not auto-detected. Please enter server settings manually.');
  }

  return promptServerSettings(defaults);
}

/**
 * Build a normalized AccountConfig for connection testing.
 */
function buildTestAccount(
  identity: { name: string; email: string; fullName: string },
  creds: { username: string; password: string },
  server: ServerSettings,
): AccountConfig {
  return {
    name: identity.name,
    email: identity.email,
    fullName: identity.fullName || undefined,
    username: creds.username || identity.email,
    password: creds.password,
    imap: {
      host: server.imapHost,
      port: server.imapPort,
      tls: server.imapTls,
      starttls: !server.imapTls,
      verifySsl: true,
    },
    smtp: {
      host: server.smtpHost,
      port: server.smtpPort,
      tls: server.smtpTls,
      starttls: server.smtpStarttls,
      verifySsl: true,
      pool: {
        enabled: server.smtpPoolEnabled,
        maxConnections: server.smtpPoolMaxConnections,
        maxMessages: server.smtpPoolMaxMessages,
      },
    },
  };
}

/**
 * Test IMAP and SMTP connections. Returns true if both succeed or user opts to proceed.
 */
async function testConnections(account: AccountConfig): Promise<boolean> {
  const spinner = p_spinner();

  spinner.start('Testing IMAP connection…');
  const imapResult = await ConnectionManager.testImap(account);
  if (imapResult.success) {
    spinner.stop(
      `IMAP ✓ ${account.imap.host}:${account.imap.port} — ${imapResult.details?.messages} messages, ${imapResult.details?.folders} folders`,
    );
  } else {
    spinner.stop(`IMAP ✗ ${imapResult.error}`);
  }

  spinner.start('Testing SMTP connection…');
  const smtpResult = await ConnectionManager.testSmtp(account);
  if (smtpResult.success) {
    spinner.stop(`SMTP ✓ ${account.smtp.host}:${account.smtp.port} — authenticated`);
  } else {
    spinner.stop(`SMTP ✗ ${smtpResult.error}`);
  }

  if (!imapResult.success || !smtpResult.success) {
    const proceed = await confirm({
      message: 'Some connections failed. Save config anyway?',
      initialValue: false,
    });
    if (isCancel(proceed) || !proceed) {
      cancel('Cancelled. Please check your credentials and server settings.');
      return false;
    }
  }

  return true;
}

/**
 * Build a RawAccountConfig from collected data.
 */
function buildRawAccount(
  identity: { name: string; email: string; fullName: string },
  creds: { username: string; password: string },
  server: ServerSettings,
): RawAccountConfig {
  return {
    name: identity.name,
    email: identity.email,
    full_name: identity.fullName || undefined,
    username: creds.username || identity.email,
    password: creds.password,
    imap: {
      host: server.imapHost,
      port: server.imapPort,
      tls: server.imapTls,
      starttls: !server.imapTls,
      verify_ssl: true,
    },
    smtp: {
      host: server.smtpHost,
      port: server.smtpPort,
      tls: server.smtpTls,
      starttls: server.smtpStarttls,
      verify_ssl: true,
      pool: {
        enabled: server.smtpPoolEnabled,
        max_connections: server.smtpPoolMaxConnections,
        max_messages: server.smtpPoolMaxMessages,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

/**
 * List all configured accounts in a formatted table.
 */
async function listAccounts(): Promise<void> {
  const exists = await configExists();
  if (!exists) {
    console.error(`No config file found at: ${CONFIG_FILE}`);
    console.error("Run 'email-mcp account add' to create one.");
    return;
  }

  const config = await loadRawConfig();
  const { accounts } = config;

  if (accounts.length === 0) {
    console.log('No accounts configured.');
    return;
  }

  console.log(`\n  ${'Name'.padEnd(16)} ${'Email'.padEnd(30)} ${'IMAP'.padEnd(28)} SMTP`);
  console.log(`  ${'─'.repeat(16)} ${'─'.repeat(30)} ${'─'.repeat(28)} ${'─'.repeat(28)}`);

  accounts.forEach((acct) => {
    const imapInfo = `${acct.imap.host}:${acct.imap.port} (${formatSecurity(acct.imap.tls, acct.imap.starttls)})`;
    const smtpInfo = `${acct.smtp.host}:${acct.smtp.port} (${formatSecurity(acct.smtp.tls, acct.smtp.starttls)})`;
    console.log(
      `  ${acct.name.padEnd(16)} ${acct.email.padEnd(30)} ${imapInfo.padEnd(28)} ${smtpInfo}`,
    );
  });

  console.log(`\n  ${accounts.length} account(s) configured.\n`);
}

/**
 * Interactive wizard to add a new email account.
 */
async function addAccount(): Promise<void> {
  ensureInteractive();
  intro('email-mcp › Add Account');

  let existingConfig: RawAppConfig | undefined;
  const exists = await configExists();
  if (exists) {
    try {
      existingConfig = await loadRawConfig();
    } catch {
      log.warning('Could not parse existing config. A new config will be created.');
    }
  }

  // 1. Identity
  const identity = await promptAccountIdentity();

  // Check for duplicate names
  if (existingConfig?.accounts.some((a) => a.name === identity.name)) {
    log.error(`Account "${identity.name}" already exists. Use 'account edit' to modify it.`);
    cancel('Duplicate account name.');
    return;
  }

  // 2. Server settings (auto-detect or manual)
  const server = await resolveServerSettings(identity.email);

  // 3. Credentials
  const creds = await promptCredentials({ email: identity.email });

  // 4. Test connections
  const testAccount = buildTestAccount(identity, creds, server);
  const ok = await testConnections(testAccount);
  if (!ok) return;

  // 5. Build and save
  const newAccount = buildRawAccount(identity, creds, server);
  const config: RawAppConfig = existingConfig
    ? {
        ...existingConfig,
        accounts: [...existingConfig.accounts, newAccount],
      }
    : {
        settings: {
          rate_limit: 10,
          read_only: false,
          watcher: {
            enabled: false,
            folders: ['INBOX'],
            idle_timeout: 1740,
          },
          hooks: {
            on_new_email: 'notify',
            preset: 'priority-focus',
            auto_label: false,
            auto_flag: false,
            batch_delay: 5,
            rules: [],
            alerts: {
              desktop: false,
              sound: false,
              urgency_threshold: 'high',
              webhook_url: '',
              webhook_events: ['urgent', 'high'],
            },
            auto_calendar: false,
            calendar_name: '',
            calendar_alarm_minutes: 15,
            calendar_confirm: true,
          },
        },
        accounts: [newAccount],
      };

  AppConfigFileSchema.parse(config);
  await saveConfig(config);
  log.success(`Account "${identity.name}" added. Config saved to ${CONFIG_FILE}`);

  note(
    JSON.stringify(
      {
        mcpServers: {
          email: {
            command: 'email-mcp',
            args: ['stdio'],
          },
        },
      },
      null,
      2,
    ),
    'Add this to your MCP client config (e.g., Claude Desktop, Cursor)',
  );

  outro('Done!');
}

/**
 * Interactive editor for an existing account.
 * Shows a field selector so users can pick exactly what to change.
 */
async function editAccount(nameArg?: string): Promise<void> {
  ensureInteractive();
  intro('email-mcp › Edit Account');

  const exists = await configExists();
  if (!exists) {
    log.error(`No config file found at: ${CONFIG_FILE}`);
    cancel("Run 'email-mcp account add' first.");
    return;
  }

  const config = await loadRawConfig();
  const { accounts } = config;

  // Resolve which account to edit
  let accountIndex: number;
  if (nameArg) {
    accountIndex = accounts.findIndex((a) => a.name === nameArg);
    if (accountIndex === -1) {
      log.error(`Account "${nameArg}" not found.`);
      log.info(`Available accounts: ${accounts.map((a) => a.name).join(', ')}`);
      cancel('Account not found.');
      return;
    }
  } else if (accounts.length === 1) {
    accountIndex = 0;
    log.info(`Editing account "${accounts[0].name}".`);
  } else {
    const chosen = await select({
      message: 'Which account do you want to edit?',
      options: accounts.map((a, i) => ({
        value: i,
        label: a.name,
        hint: a.email,
      })),
    });
    assertNotCancel(chosen);
    accountIndex = chosen;
  }

  const current = accounts[accountIndex];

  // Field selector — let user choose what to edit
  const fields = await select({
    message: `Editing "${current.name}" — what would you like to change?`,
    options: [
      {
        value: 'identity',
        label: 'Name, email, or display name',
        hint: `${current.name} <${current.email}>`,
      },
      {
        value: 'servers',
        label: 'Server settings (IMAP/SMTP)',
        hint: `${current.imap.host}, ${current.smtp.host}`,
      },
      {
        value: 'credentials',
        label: 'Username or password',
        hint: current.username ?? current.email,
      },
      {
        value: 'all',
        label: 'Everything',
        hint: 'Re-configure from scratch',
      },
    ],
  });
  assertNotCancel(fields);

  let identity = {
    name: current.name,
    email: current.email,
    fullName: current.full_name ?? '',
  };
  let server: ServerSettings = {
    imapHost: current.imap.host,
    imapPort: current.imap.port,
    imapTls: current.imap.tls,
    smtpHost: current.smtp.host,
    smtpPort: current.smtp.port,
    smtpTls: current.smtp.tls,
    smtpStarttls: current.smtp.starttls,
    smtpPoolEnabled: current.smtp.pool?.enabled ?? true,
    smtpPoolMaxConnections: current.smtp.pool?.max_connections ?? 1,
    smtpPoolMaxMessages: current.smtp.pool?.max_messages ?? 100,
  };
  let creds = {
    username: current.username ?? current.email,
    password: current.password ?? '',
  };

  if (fields === 'identity' || fields === 'all') {
    identity = await promptAccountIdentity(identity);
    // If name changed, check for duplicates
    if (identity.name !== current.name) {
      if (accounts.some((a, i) => i !== accountIndex && a.name === identity.name)) {
        log.error(`Account "${identity.name}" already exists.`);
        cancel('Duplicate account name.');
        return;
      }
    }
  }

  if (fields === 'servers' || fields === 'all') {
    if (fields === 'all') {
      server = await resolveServerSettings(identity.email, server);
    } else {
      server = await promptServerSettings(server);
    }
  }

  if (fields === 'credentials' || fields === 'all') {
    creds = await promptCredentials({
      username: creds.username,
      email: identity.email,
    });
  }

  // Test connections
  const shouldTest = await confirm({
    message: 'Test connections with updated settings?',
    initialValue: true,
  });
  assertNotCancel(shouldTest);

  if (shouldTest) {
    const testAccount = buildTestAccount(identity, creds, server);
    const ok = await testConnections(testAccount);
    if (!ok) return;
  }

  // Save updated account
  const updatedAccount = buildRawAccount(identity, creds, server);
  const updatedAccounts = [...accounts];
  updatedAccounts[accountIndex] = updatedAccount;

  const updatedConfig: RawAppConfig = {
    ...config,
    accounts: updatedAccounts,
  };

  AppConfigFileSchema.parse(updatedConfig);
  await saveConfig(updatedConfig);
  log.success(`Account "${identity.name}" updated. Config saved to ${CONFIG_FILE}`);
  outro('Done!');
}

/**
 * Delete an account with confirmation.
 * Refuses to delete the last remaining account.
 */
async function deleteAccount(nameArg?: string): Promise<void> {
  ensureInteractive();
  intro('email-mcp › Delete Account');

  const exists = await configExists();
  if (!exists) {
    log.error(`No config file found at: ${CONFIG_FILE}`);
    cancel('Nothing to delete.');
    return;
  }

  const config = await loadRawConfig();
  const { accounts } = config;

  if (accounts.length === 0) {
    log.info('No accounts configured.');
    cancel('Nothing to delete.');
    return;
  }

  if (accounts.length === 1) {
    log.error('Cannot delete the last account. At least one account must remain.');
    log.info("Use 'email-mcp account edit' to modify it instead.");
    cancel('Operation refused.');
    return;
  }

  // Resolve which account to delete
  let accountIndex: number;
  if (nameArg) {
    accountIndex = accounts.findIndex((a) => a.name === nameArg);
    if (accountIndex === -1) {
      log.error(`Account "${nameArg}" not found.`);
      log.info(`Available accounts: ${accounts.map((a) => a.name).join(', ')}`);
      cancel('Account not found.');
      return;
    }
  } else {
    const chosen = await select({
      message: 'Which account do you want to delete?',
      options: accounts.map((a, i) => ({
        value: i,
        label: a.name,
        hint: a.email,
      })),
    });
    assertNotCancel(chosen);
    accountIndex = chosen;
  }

  const target = accounts[accountIndex];

  // Require explicit confirmation
  const confirmed = await confirm({
    message: `Delete account "${target.name}" (${target.email})? This cannot be undone.`,
    initialValue: false,
  });

  if (isCancel(confirmed) || !confirmed) {
    cancel('Deletion cancelled.');
    return;
  }

  const updatedAccounts = accounts.filter((_, i) => i !== accountIndex);
  const updatedConfig: RawAppConfig = {
    ...config,
    accounts: updatedAccounts,
  };

  AppConfigFileSchema.parse(updatedConfig);
  await saveConfig(updatedConfig);
  log.success(`Account "${target.name}" deleted. Config saved to ${CONFIG_FILE}`);
  outro('Done!');
}

// ---------------------------------------------------------------------------
// Usage + dispatch
// ---------------------------------------------------------------------------

function printAccountUsage(): void {
  console.log(`Usage: email-mcp account <subcommand>

Subcommands:
  list              List all configured accounts
  add               Add a new email account interactively
  edit [name]       Edit an existing account
  delete [name]     Remove an account

Examples:
  email-mcp account list
  email-mcp account add
  email-mcp account edit personal
  email-mcp account delete work
`);
}

export default async function runAccountCommand(subcommand?: string, arg?: string): Promise<void> {
  try {
    switch (subcommand) {
      case 'list':
      case 'ls':
        await listAccounts();
        return;
      case 'add':
      case 'new':
        await addAccount();
        return;
      case 'edit':
        await editAccount(arg);
        return;
      case 'delete':
      case 'rm':
      case 'remove':
        await deleteAccount(arg);
        return;
      default:
        printAccountUsage();
    }
  } catch (err) {
    if (err instanceof CancelledError) return;
    throw err;
  }
}
