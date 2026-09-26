/**
 * Audit logger — append-only JSON Lines log for all write operations.
 *
 * Logs are stored at the XDG data directory:
 *   ~/.local/share/email-mcp/audit.log
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { xdg } from '../config/xdg.js';

import type { AuditEntry } from '../types/index.js';

const AUDIT_LOG_PATH = path.join(xdg.data, 'audit.log');

/** Fields redacted from audit params to protect sensitive data. */
const REDACTED_FIELDS = new Set([
  'password',
  'body',
  'bodyText',
  'bodyHtml',
  'content_base64',
  // Verification secrets — never let a caught OTP/magic link reach the audit log.
  'code',
  'link',
]);

function redactParams(params: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  Object.entries(params).forEach(([key, value]) => {
    if (REDACTED_FIELDS.has(key)) {
      cleaned[key] = '[REDACTED]';
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      cleaned[key] = redactParams(value as Record<string, unknown>);
    } else {
      cleaned[key] = value;
    }
  });
  return cleaned;
}

async function ensureLogDir(): Promise<void> {
  await fs.mkdir(path.dirname(AUDIT_LOG_PATH), { recursive: true });
}

/**
 * Append a single audit entry to the log file.
 * Creates the directory and file if they don't exist.
 */
async function log(
  tool: string,
  account: string,
  params: Record<string, unknown>,
  result: 'ok' | 'error',
  error?: string,
): Promise<void> {
  await ensureLogDir();

  const entry: AuditEntry = {
    ts: new Date().toISOString(),
    tool,
    account,
    params: redactParams(params),
    result,
    ...(error ? { error } : {}),
  };

  const line = `${JSON.stringify(entry)}\n`;
  await fs.appendFile(AUDIT_LOG_PATH, line, 'utf-8');
}

const audit = { log, AUDIT_LOG_PATH } as const;

export default audit;
