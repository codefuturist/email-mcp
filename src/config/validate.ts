/**
 * Static config validation beyond what zod parsing gives us.
 *
 * The config schemas are deliberately non-strict (unknown TOML keys are
 * ignored at load time so old servers tolerate new keys) — which turns a
 * typo like `auto_copu = true` into silently-dropped intent. `config
 * validate` closes that gap: unknown keys are found by walking the parsed
 * TOML against the zod schema tree itself (no hand-maintained key lists,
 * so new settings are covered automatically), plus cross-setting
 * consistency checks for the mistakes a schema cannot see.
 */

import { z } from 'zod';
import type { RawAppConfig } from './schema.js';
import { AppConfigFileSchema } from './schema.js';

export interface UnknownKey {
  /** Dotted path of the unrecognized key, e.g. `settings.verification.auto_copu`. */
  path: string;
  /** Closest known key at that level, when one is plausibly meant. */
  suggestion?: string;
}

export interface ConsistencyIssue {
  severity: 'error' | 'warning';
  message: string;
}

/** Peel ZodDefault/ZodOptional/ZodNullable/… down to the concrete schema. */
function unwrapSchema(schema: unknown): unknown {
  let current = schema;
  while (
    current &&
    typeof (current as { unwrap?: unknown }).unwrap === 'function' &&
    // Stop at the concrete containers — ZodArray.unwrap() would jump to the
    // element type and make the walker skip the array level entirely.
    !(current instanceof z.ZodObject) &&
    !(current instanceof z.ZodArray)
  ) {
    current = (current as { unwrap: () => unknown }).unwrap();
  }
  return current;
}

function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[] = Array.from({ length: cols }, (_, j) => j);
  for (let i = 1; i < rows; i += 1) {
    let prev = d[0] as number;
    d[0] = i;
    for (let j = 1; j < cols; j += 1) {
      const tmp = d[j] as number;
      d[j] = Math.min(
        (d[j] as number) + 1,
        (d[j - 1] as number) + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = tmp;
    }
  }
  return d[cols - 1] as number;
}

function nearestKey(key: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = 3; // suggest only close misses
  for (const candidate of candidates) {
    const distance = levenshtein(key, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function walk(value: unknown, schema: unknown, path: string, out: UnknownKey[]): void {
  const concrete = unwrapSchema(schema);

  if (concrete instanceof z.ZodObject && isPlainObject(value)) {
    const shape = concrete.shape as Record<string, unknown>;
    const known = Object.keys(shape);
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (key in shape) {
        walk(child, shape[key], childPath, out);
      } else {
        out.push({ path: childPath, suggestion: nearestKey(key, known) });
      }
    }
    return;
  }

  if (concrete instanceof z.ZodArray && Array.isArray(value)) {
    const element = concrete.element;
    value.forEach((item, index) => {
      walk(item, element, `${path}[${index}]`, out);
    });
  }
}

/** Keys present in the parsed TOML that no schema knows about. */
export function findUnknownKeys(raw: unknown): UnknownKey[] {
  const out: UnknownKey[] = [];
  walk(raw, AppConfigFileSchema, '', out);
  return out;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '[::1]']);

/** Cross-setting mistakes a per-field schema cannot see. */
export function findConsistencyIssues(raw: RawAppConfig): ConsistencyIssue[] {
  const issues: ConsistencyIssue[] = [];
  const { settings, accounts } = raw;

  const seen = new Set<string>();
  for (const account of accounts) {
    if (seen.has(account.name)) {
      issues.push({
        severity: 'error',
        message: `duplicate account name "${account.name}" — every tool addresses accounts by name`,
      });
    }
    seen.add(account.name);
  }

  if (!settings.watcher.enabled) {
    if (settings.verification.enabled) {
      issues.push({
        severity: 'warning',
        message:
          '[settings.verification] is enabled but [settings.watcher] is off — ambient ' +
          'auto-copy never fires (get_verification_code still works on demand)',
      });
    }
    if (settings.hooks.on_new_email !== 'none') {
      issues.push({
        severity: 'warning',
        message:
          `[settings.hooks] on_new_email = "${settings.hooks.on_new_email}" but ` +
          '[settings.watcher] is off — hooks never receive new-mail events',
      });
    }
  } else if (settings.watcher.folders.length === 0) {
    issues.push({
      severity: 'warning',
      message: '[settings.watcher] is enabled with an empty folders list — nothing is watched',
    });
  }

  if (!LOOPBACK_HOSTS.has(settings.server.host) && settings.server.token === '') {
    issues.push({
      severity: 'error',
      message:
        `[settings.server] host = "${settings.server.host}" is not loopback and no token is set — ` +
        'the HTTP server will refuse to start (set a token, or pass --insecure per run)',
    });
  }

  const accountNames = new Set(accounts.map((a) => a.name));
  for (const name of settings.verification.accounts) {
    if (!accountNames.has(name)) {
      issues.push({
        severity: 'warning',
        message: `[settings.verification] accounts references unknown account "${name}"`,
      });
    }
  }

  return issues;
}
