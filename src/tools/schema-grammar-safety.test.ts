/**
 * Guards a property of the whole tool surface, not of any one tool:
 *
 *   No tool input schema may emit a regex containing a lookaround assertion.
 *
 * llama.cpp compiles the entire `tools` array into a single GBNF grammar for
 * constrained decoding, and GBNF has no lookahead/lookbehind. One offending
 * `pattern` anywhere aborts grammar compilation, so every tool in the request
 * fails — including tools belonging to other servers. OpenAI's tool-schema
 * validator rejects the same construct ("regex lookaround is not supported").
 *
 * This is why the check walks every registered tool rather than asserting on
 * the handful of call sites that happened to be wrong: the next `.email()`,
 * `.url()`, or hand-written `.regex()` must fail here too.
 *
 * See upstream issue #58.
 */

import { z } from 'zod';
import type { AppConfig } from '../types/index.js';
import registerAllTools from './register.js';

/** Matches lookahead `(?=` `(?!` and lookbehind `(?<=` `(?<!`, ignoring `(?:`. */
const LOOKAROUND = /\((?:\?=|\?!|\?<=|\?<!)/;

interface CapturedTool {
  name: string;
  shape: z.ZodRawShape | z.ZodTypeAny;
}

/** Stands in for any service: every property is a no-op function. */
function serviceStub(): unknown {
  return new Proxy(
    {},
    {
      get: () => () => undefined,
    },
  );
}

function createConfig(): AppConfig {
  return {
    settings: {
      rateLimit: 10,
      readOnly: false,
      cache: {
        enabled: false,
        mailboxes: ['INBOX'],
        windowDays: 30,
        bodyMessages: 200,
        maxSizeMb: 100,
        syncInterval: 300,
      },
      watcher: { enabled: false, folders: ['INBOX'], idleTimeout: 1740 },
      hooks: {
        onNewEmail: 'notify',
        preset: 'priority-focus',
        autoLabel: false,
        autoFlag: false,
        batchDelay: 5,
        rules: [],
        alerts: {
          desktop: false,
          sound: false,
          urgencyThreshold: 'high',
          webhookUrl: '',
          webhookEvents: ['urgent', 'high'],
        },
      },
    },
    accounts: [],
  };
}

function captureRegisteredTools(): CapturedTool[] {
  const captured: CapturedTool[] = [];

  const recordTool = (name: string, ...rest: unknown[]): void => {
    // server.tool(name, description?, shape?, annotations?, handler)
    const shape = rest.find(
      (arg) => typeof arg === 'object' && arg !== null && !Array.isArray(arg),
    ) as z.ZodRawShape | undefined;
    if (shape) captured.push({ name, shape });
  };

  const fakeServer = {
    tool: recordTool,
    registerTool: (name: string, cfg: { inputSchema?: z.ZodRawShape | z.ZodTypeAny }) => {
      if (cfg?.inputSchema) captured.push({ name, shape: cfg.inputSchema });
    },
    prompt: () => undefined,
    resource: () => undefined,
    server: serviceStub(),
  };

  const stub = serviceStub() as never;
  registerAllTools(
    fakeServer as never,
    stub,
    stub,
    stub,
    createConfig(),
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
  );

  return captured;
}

/**
 * A tool's input schema arrives either as a raw shape (`server.tool`, SDK v1)
 * or as a `ZodObject` (`server.registerTool`, SDK v2). Normalize both, and
 * return null only when the schema genuinely cannot be serialized — which the
 * companion test treats as a failure, not as something to skip. Swallowing it
 * silently is how this guard would pass while checking nothing.
 */
function toJson(shape: z.ZodRawShape | z.ZodTypeAny): string | null {
  const schema = shape instanceof z.ZodType ? shape : z.object(shape);
  try {
    return JSON.stringify(z.toJSONSchema(schema));
  } catch {
    return null;
  }
}

describe('tool schemas are GBNF-compilable', () => {
  const tools = captureRegisteredTools();

  it('registers a meaningful number of tools (guards against a silent no-op)', () => {
    expect(tools.length).toBeGreaterThan(20);
  });

  it('can serialize every captured tool schema (guards against a vacuous pass)', () => {
    const unserializable = tools.filter(({ shape }) => toJson(shape) === null).map((t) => t.name);
    expect(unserializable).toEqual([]);
  });

  it('emits no lookaround assertions in any tool input schema', () => {
    const offenders: string[] = [];

    for (const { name, shape } of tools) {
      const json = toJson(shape);
      if (json !== null && LOOKAROUND.test(json)) {
        const pattern = /"pattern":"((?:[^"\\]|\\.)*)"/.exec(json)?.[1] ?? '(unknown)';
        offenders.push(`${name}: ${pattern}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
