/**
 * Config management subcommands.
 *
 * - config show           — display the full config with masked passwords
 * - config edit [section] — interactive settings editor (all sections)
 * - config path           — print config file path
 * - config init           — create a template config file
 */

import fs from 'node:fs/promises';

import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  multiselect,
  note,
  outro,
  select,
  text,
} from '@clack/prompts';

import { parse as parseTOML } from 'smol-toml';

import {
  CONFIG_FILE,
  configExists,
  generateTemplate,
  loadRawConfig,
  saveConfigValidated,
} from '../config/loader.js';
import { AppConfigFileSchema } from '../config/schema.js';
import { findConsistencyIssues, findUnknownKeys } from '../config/validate.js';
import ensureInteractive, { assertNotCancel, CancelledError } from './guard.js';
import type { FieldDescriptor, SectionDescriptor } from './settings-fields.js';
import {
  diffSection,
  formatFieldValue,
  parseFieldInput,
  resolveSection,
  SETTINGS_SECTIONS,
  validateFieldInput,
} from './settings-fields.js';

function printConfigUsage(): void {
  console.log(`Usage: email-mcp config <subcommand>

Subcommands:
  show            Show current configuration (passwords masked)
  edit [section]  Edit settings interactively
                  Sections: ${SETTINGS_SECTIONS.map((s) => s.id).join(', ')}
  validate        Check the config file: syntax, schema, typo'd keys,
                  cross-setting consistency (exit 1 on errors; CI-friendly)
  path            Print config file path
  init            Create a template config file
`);
}

function showPath(): void {
  console.log(CONFIG_FILE);
}

function sectionHeader(section: SectionDescriptor): string {
  if (section.id === 'general') return '[settings]';
  if (section.id === 'alerts') return '[settings.hooks.alerts]';
  return `[settings.${section.id}]`;
}

async function showConfig(): Promise<void> {
  const exists = await configExists();
  if (!exists) {
    console.error(`No config file found at: ${CONFIG_FILE}`);
    console.error(`Run 'email-mcp setup' or 'email-mcp config init' to create one.`);
    throw new Error('Config file not found');
  }

  let raw: Awaited<ReturnType<typeof loadRawConfig>>;
  try {
    raw = await loadRawConfig();
  } catch (err) {
    throw new Error(`Failed to load config: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log(`Config file: ${CONFIG_FILE}\n`);

  for (const section of SETTINGS_SECTIONS) {
    const values = section.resolve(raw);
    const pad = Math.max(...section.fields.map((f) => f.key.length), 'rules'.length);
    console.log(sectionHeader(section));
    for (const f of section.fields) {
      console.log(`  ${f.key.padEnd(pad)} = ${formatFieldValue(f, values[f.key])}`);
    }
    if (section.id === 'hooks') {
      const ruleCount = raw.settings.hooks.rules.length;
      console.log(`  ${'rules'.padEnd(pad)} = ${ruleCount} rule(s) — edit in config.toml`);
    }
    console.log('');
  }

  raw.accounts.forEach((account) => {
    console.log(`[accounts.${account.name}]`);
    console.log(`  email    = ${account.email}`);
    if (account.full_name) {
      console.log(`  name     = ${account.full_name}`);
    }
    const imapLabel = account.imap.starttls ? 'STARTTLS' : account.imap.tls ? 'TLS' : 'plain';
    const smtpLabel = account.smtp.starttls ? 'STARTTLS' : account.smtp.tls ? 'TLS' : 'plain';
    const pool = account.smtp.pool;
    console.log(`  imap     = ${account.imap.host}:${account.imap.port} (${imapLabel})`);
    console.log(`  smtp     = ${account.smtp.host}:${account.smtp.port} (${smtpLabel})`);
    console.log(
      `  smtp_pool = ${
        pool.enabled
          ? `enabled (${pool.max_connections} conns, ${pool.max_messages} msgs/conn)`
          : 'disabled'
      }`,
    );
    console.log(`  password = ${'•'.repeat(8)}\n`);
  });
}

async function initConfig(): Promise<void> {
  ensureInteractive();
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

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Static validation of the config file. Non-interactive and CI-friendly:
 * exit code 1 on errors, 0 when valid (warnings allowed). Live connection
 * checks stay in `email-mcp test`.
 */
async function validateConfig(): Promise<void> {
  console.log(`Validating ${CONFIG_FILE}\n`);

  if (!(await configExists())) {
    console.error(`❌ No config file found at: ${CONFIG_FILE}`);
    console.error(`   Run 'email-mcp account add' or 'email-mcp config init' to create one.`);
    process.exitCode = 1;
    return;
  }

  const fsp = await import('node:fs/promises');
  const content = await fsp.readFile(CONFIG_FILE, 'utf-8');

  let parsed: unknown;
  try {
    parsed = parseTOML(content);
  } catch (err) {
    console.error(`❌ TOML syntax error:\n   ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }
  console.log('✅ TOML syntax');

  let errorCount = 0;
  let warningCount = 0;

  const result = AppConfigFileSchema.safeParse(parsed);
  if (result.success) {
    console.log('✅ Schema (accounts and all settings sections)');
  } else {
    console.log('❌ Schema:');
    for (const issue of result.error.issues) {
      const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      console.log(`   ❌ ${where}: ${issue.message}`);
      errorCount += 1;
    }
  }

  const unknown = findUnknownKeys(parsed);
  if (unknown.length === 0) {
    console.log('✅ No unknown keys');
  } else {
    console.log('⚠️ Unknown keys (silently ignored by the server):');
    for (const u of unknown) {
      const hint = u.suggestion ? ` — did you mean "${u.suggestion}"?` : '';
      console.log(`   ⚠️ ${u.path}${hint}`);
      warningCount += 1;
    }
  }

  if (result.success) {
    const issues = findConsistencyIssues(result.data);
    if (issues.length === 0) {
      console.log('✅ Settings are consistent');
    } else {
      console.log('Consistency:');
      for (const issue of issues) {
        console.log(`   ${issue.severity === 'error' ? '❌' : '⚠️'} ${issue.message}`);
        if (issue.severity === 'error') errorCount += 1;
        else warningCount += 1;
      }
    }
  }

  console.log('');
  if (errorCount > 0) {
    console.error(`❌ Config invalid — ${errorCount} error(s), ${warningCount} warning(s).`);
    process.exitCode = 1;
    return;
  }
  console.log(`✅ Config valid — ${warningCount} warning(s).`);
  console.log(`   Live connection check: email-mcp test`);
}

// ---------------------------------------------------------------------------
// Interactive section editor
// ---------------------------------------------------------------------------

/**
 * Edit one field in place on the working section object. A cancelled prompt
 * simply returns to the field menu without changing anything.
 */
async function editField(f: FieldDescriptor, target: Record<string, unknown>): Promise<void> {
  const current = target[f.key];

  switch (f.kind) {
    case 'boolean': {
      const v = await confirm({ message: f.label, initialValue: Boolean(current) });
      if (isCancel(v)) return;
      target[f.key] = v;
      return;
    }
    case 'enum': {
      const v = await select({
        message: f.label,
        initialValue: current as string,
        options: (f.options ?? []).map((o) => ({ value: o, label: o })),
      });
      if (isCancel(v)) return;
      target[f.key] = v;
      return;
    }
    case 'enum-array': {
      const v = await multiselect({
        message: `${f.label} (space to toggle)`,
        initialValues: Array.isArray(current) ? (current as string[]) : [],
        options: (f.options ?? []).map((o) => ({ value: o, label: o })),
        required: false,
      });
      if (isCancel(v)) return;
      target[f.key] = v;
      return;
    }
    case 'int': {
      const v = await text({
        message: f.label,
        defaultValue: String(current ?? ''),
        initialValue: String(current ?? ''),
        validate: (input) => validateFieldInput(f, input ?? ''),
      });
      if (isCancel(v)) return;
      target[f.key] = parseFieldInput(f, v);
      return;
    }
    case 'string-array': {
      const currentText = Array.isArray(current) ? (current as string[]).join(', ') : '';
      const emptyHint = f.emptyLabel ? `; empty = ${f.emptyLabel}` : '';
      const v = await text({
        message: `${f.label} (comma-separated${emptyHint})`,
        initialValue: currentText,
        validate: (input) => validateFieldInput(f, input ?? ''),
      });
      if (isCancel(v)) return;
      target[f.key] = parseFieldInput(f, v);
      return;
    }
    default: {
      // string — no defaultValue so the value can be cleared to empty/unset.
      const v = await text({
        message: f.label,
        initialValue: typeof current === 'string' ? current : '',
        validate: (input) => validateFieldInput(f, input ?? ''),
      });
      if (isCancel(v)) return;
      const parsed = parseFieldInput(f, v);
      if (parsed === undefined) {
        delete target[f.key];
      } else {
        target[f.key] = parsed;
      }
      return;
    }
  }
}

async function editSettings(sectionArg?: string): Promise<void> {
  ensureInteractive();
  intro('email-mcp › Edit Settings');

  const exists = await configExists();
  if (!exists) {
    log.error(`No config file found at: ${CONFIG_FILE}`);
    cancel("Run 'email-mcp account add' or 'email-mcp config init' first.");
    return;
  }

  const original = await loadRawConfig();
  const working = structuredClone(original);

  let section: SectionDescriptor | undefined;
  if (sectionArg !== undefined) {
    section = resolveSection(sectionArg);
    if (!section) {
      log.error(
        `Unknown section "${sectionArg}". Sections: ${SETTINGS_SECTIONS.map((s) => s.id).join(', ')}`,
      );
      cancel('Cancelled.');
      return;
    }
  } else {
    const picked = await select({
      message: 'Which section do you want to edit?',
      options: SETTINGS_SECTIONS.map((s) => ({
        value: s.id,
        label: s.label,
        hint: s.summarize(working),
      })),
    });
    assertNotCancel(picked);
    section = resolveSection(picked);
  }
  if (!section) return;

  const before = section.resolve(original);
  const workingSection = section.resolve(working);

  for (;;) {
    const changes = diffSection(section, before, workingSection);
    const choice = await select({
      message: `${section.label} — choose a field to edit`,
      options: [
        ...section.fields.map((f) => ({
          value: f.key,
          label: f.key,
          hint: formatFieldValue(f, workingSection[f.key]),
        })),
        {
          value: '$save',
          label:
            changes.length > 0 ? `Save changes (${changes.length} pending)` : 'Save (no changes)',
        },
        { value: '$discard', label: 'Discard and exit' },
      ],
    });
    const action = isCancel(choice) ? '$discard' : choice;

    if (action === '$discard') {
      if (changes.length > 0) {
        const sure = await confirm({
          message: `Discard ${changes.length} unsaved change(s)?`,
          initialValue: false,
        });
        if (isCancel(sure) || !sure) continue;
      }
      cancel('No changes saved.');
      return;
    }

    if (action === '$save') {
      if (changes.length === 0) {
        // Never rewrite the file gratuitously — every write costs comments.
        outro('No changes.');
        return;
      }
      note(changes.map((c) => `${c.key}: ${c.before} → ${c.after}`).join('\n'), 'Pending changes');
      const sure = await confirm({ message: `Save to ${CONFIG_FILE}?`, initialValue: true });
      if (isCancel(sure) || !sure) continue;

      const result = await saveConfigValidated(working);
      if (result.commentsLost) {
        log.warn(
          `Saving rewrites config.toml without comments; the previous file was backed up to ${result.backupPath}.`,
        );
      } else if (result.backupPath) {
        log.info(`Previous config backed up to ${result.backupPath}`);
      }
      log.success('Settings updated.');
      log.info('Restart the MCP server (or reload your MCP client) for changes to take effect.');
      outro('Done!');
      return;
    }

    const field = section.fields.find((f) => f.key === action);
    if (field) await editField(field, workingSection);
  }
}

export default async function runConfigCommand(
  subcommand?: string,
  sectionArg?: string,
): Promise<void> {
  try {
    switch (subcommand) {
      case 'show':
        await showConfig();
        return;
      case 'edit':
        await editSettings(sectionArg);
        return;
      case 'validate':
      case 'check':
        await validateConfig();
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
  } catch (err) {
    if (err instanceof CancelledError) return;
    throw err;
  }
}
