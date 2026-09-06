/**
 * MCP callers routinely send every parameter as a string. A bare `z.number()`
 * rejects "20", which breaks the tool for those clients before the handler ever
 * runs — the failure is silent from the caller's point of view.
 *
 * This walks the real tool schemas and asserts the property that prevents it:
 * a field that accepts the number 5 must also accept the string "5".
 */

import type { ZodTypeAny } from 'zod';

import registerAttachmentTools from './attachments.tool.js';
import registerBulkTools from './bulk.tool.js';
import registerCalendarTools from './calendar.tool.js';
import registerContactsTools from './contacts.tool.js';
import registerDraftTools from './drafts.tool.js';
import registerEmailsTools from './emails.tool.js';
import registerThreadTools from './thread.tool.js';

type Shape = Record<string, ZodTypeAny>;

/** Captures the schema each tool registers, without running a real server. */
function collectSchemas(register: (server: never, service: never) => void): Map<string, Shape> {
  const schemas = new Map<string, Shape>();
  const server = {
    tool: (name: string, ...rest: unknown[]) => {
      const shape = rest.find(
        (arg) => arg && typeof arg === 'object' && !Array.isArray(arg) && !('_def' in arg),
      );
      if (shape) schemas.set(name, shape as Shape);
    },
  };
  register(server as never, {} as never);
  return schemas;
}

const REGISTRARS = {
  attachments: registerAttachmentTools,
  bulk: registerBulkTools,
  calendar: registerCalendarTools,
  contacts: registerContactsTools,
  drafts: registerDraftTools,
  emails: registerEmailsTools,
  thread: registerThreadTools,
};

/** Every (tool, field) pair across the registrars above. */
function everyField(): { tool: string; field: string; schema: ZodTypeAny }[] {
  return Object.values(REGISTRARS).flatMap((register) =>
    [...collectSchemas(register as never).entries()].flatMap(([tool, shape]) =>
      Object.entries(shape).map(([field, schema]) => ({ tool, field, schema })),
    ),
  );
}

describe('numeric tool parameters accept strings', () => {
  it('finds tools to check, so a broken harness cannot pass vacuously', () => {
    const fields = everyField();

    expect(fields.length).toBeGreaterThan(20);
    expect(new Set(fields.map((f) => f.tool)).size).toBeGreaterThan(5);
  });

  it('accepts a numeric string wherever it accepts a number', () => {
    const offenders = everyField()
      .filter(({ schema }) => schema.safeParse(5).success && !schema.safeParse('5').success)
      .map(({ tool, field }) => `${tool}.${field}`);

    expect(offenders).toEqual([]);
  });

  it('accepts an array of numeric strings wherever it accepts an array of numbers', () => {
    const offenders = everyField()
      .filter(({ schema }) => schema.safeParse([5]).success && !schema.safeParse(['5']).success)
      .map(({ tool, field }) => `${tool}.${field}`);

    expect(offenders).toEqual([]);
  });
});
