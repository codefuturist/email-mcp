import type { RawAppConfig } from '../config/schema.js';
import {
  AlertsConfigSchema,
  AppConfigFileSchema,
  CacheConfigSchema,
  HooksConfigSchema,
  SettingsSchema,
  VerificationConfigSchema,
  WatcherConfigSchema,
} from '../config/schema.js';
import {
  diffSection,
  formatFieldValue,
  parseFieldInput,
  resolveSection,
  SETTINGS_SECTIONS,
  validateFieldInput,
} from './settings-fields.js';

function materializedConfig(): RawAppConfig {
  return AppConfigFileSchema.parse({
    accounts: [
      {
        name: 'test',
        email: 'user@example.com',
        password: 'secret',
        imap: { host: 'imap.example.com' },
        smtp: { host: 'smtp.example.com' },
      },
    ],
  });
}

function section(id: string) {
  const s = resolveSection(id);
  if (!s) throw new Error(`section ${id} missing`);
  return s;
}

function field(sectionId: string, key: string) {
  const f = section(sectionId).fields.find((x) => x.key === key);
  if (!f) throw new Error(`field ${sectionId}.${key} missing`);
  return f;
}

describe('SETTINGS_SECTIONS drift guards', () => {
  // Both directions: every schema key is in the catalog (minus deliberate
  // exclusions) and the catalog invents no keys the schema lacks.
  const cases: [string, Record<string, unknown>, string[]][] = [
    ['general', SettingsSchema.shape, ['verification', 'cache', 'watcher', 'hooks']],
    ['watcher', WatcherConfigSchema.shape, []],
    ['verification', VerificationConfigSchema.shape, []],
    ['cache', CacheConfigSchema.shape, []],
    ['hooks', HooksConfigSchema.shape, ['rules', 'alerts']],
    ['alerts', AlertsConfigSchema.shape, []],
  ];

  it.each(cases)('%s covers its schema exactly', (id, shape, excluded) => {
    const catalogKeys = section(id)
      .fields.map((f) => f.key)
      .sort();
    const schemaKeys = Object.keys(shape)
      .filter((k) => !excluded.includes(k))
      .sort();
    expect(catalogKeys).toEqual(schemaKeys);
  });

  it('exposes all six sections in order', () => {
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toEqual([
      'general',
      'watcher',
      'verification',
      'cache',
      'hooks',
      'alerts',
    ]);
  });

  it('resolveSection returns undefined for unknown ids', () => {
    expect(resolveSection('nonsense')).toBeUndefined();
    expect(resolveSection(undefined)).toBeUndefined();
  });
});

describe('validateFieldInput (ranges come from the real zod schemas)', () => {
  const rejects = (sectionId: string, key: string, input: string) =>
    expect(validateFieldInput(field(sectionId, key), input)).toBeTruthy();
  const accepts = (sectionId: string, key: string, input: string) =>
    expect(validateFieldInput(field(sectionId, key), input)).toBeUndefined();

  it('enforces idle_timeout 60-1740', () => {
    rejects('watcher', 'idle_timeout', '59');
    accepts('watcher', 'idle_timeout', '60');
    accepts('watcher', 'idle_timeout', '1740');
    rejects('watcher', 'idle_timeout', '1741');
  });

  it('enforces clear_after_seconds 0-3600', () => {
    accepts('verification', 'clear_after_seconds', '0');
    accepts('verification', 'clear_after_seconds', '3600');
    rejects('verification', 'clear_after_seconds', '3601');
  });

  it('enforces max_age_minutes 1-1440', () => {
    rejects('verification', 'max_age_minutes', '0');
    accepts('verification', 'max_age_minutes', '1');
    accepts('verification', 'max_age_minutes', '1440');
    rejects('verification', 'max_age_minutes', '1441');
  });

  it('enforces batch_delay 1-60 and sync_interval min 30', () => {
    rejects('hooks', 'batch_delay', '0');
    accepts('hooks', 'batch_delay', '60');
    rejects('hooks', 'batch_delay', '61');
    rejects('cache', 'sync_interval', '29');
    accepts('cache', 'sync_interval', '30');
  });

  it('enforces rate_limit min 1 and rejects non-numbers', () => {
    rejects('general', 'rate_limit', '0');
    accepts('general', 'rate_limit', '1');
    rejects('general', 'rate_limit', 'abc');
  });
});

describe('parseFieldInput', () => {
  it('parses ints to numbers', () => {
    expect(parseFieldInput(field('watcher', 'idle_timeout'), '900')).toBe(900);
  });

  it('splits and trims comma-separated arrays', () => {
    expect(parseFieldInput(field('verification', 'sender_allowlist'), 'a, b ,c')).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(parseFieldInput(field('verification', 'accounts'), '')).toEqual([]);
  });

  it('turns empty input into undefined for optional strings', () => {
    expect(parseFieldInput(field('hooks', 'custom_instructions'), '')).toBeUndefined();
    expect(parseFieldInput(field('hooks', 'custom_instructions'), 'be brief')).toBe('be brief');
  });
});

describe('formatFieldValue', () => {
  it('joins arrays and applies emptyLabel', () => {
    const f = field('verification', 'sender_allowlist');
    expect(formatFieldValue(f, ['*@github.com', '*@google.com'])).toBe(
      '*@github.com, *@google.com',
    );
    expect(formatFieldValue(f, [])).toContain('all');
  });

  it('renders unset optionals as (not set)', () => {
    expect(formatFieldValue(field('hooks', 'custom_instructions'), undefined)).toBe('(not set)');
  });

  it('truncates long strings to one line', () => {
    const long = 'x'.repeat(200);
    const rendered = formatFieldValue(field('hooks', 'system_prompt'), long);
    expect(rendered.length).toBeLessThan(80);
    expect(rendered).toContain('…');
  });
});

describe('diffSection', () => {
  it('returns [] when nothing changed', () => {
    const raw = materializedConfig();
    const s = section('verification');
    expect(diffSection(s, s.resolve(raw), s.resolve(structuredClone(raw)))).toEqual([]);
  });

  it('reports scalar, array, and unset→set changes', () => {
    const before = materializedConfig();
    const after = structuredClone(before);
    after.settings.verification.confirm_copy = true;
    after.settings.verification.sender_allowlist = ['*@github.com'];
    after.settings.hooks.custom_instructions = 'be brief';

    const v = section('verification');
    const verificationChanges = diffSection(v, v.resolve(before), v.resolve(after));
    expect(verificationChanges).toEqual([
      { key: 'confirm_copy', before: 'false', after: 'true' },
      { key: 'sender_allowlist', before: expect.stringContaining('all'), after: '*@github.com' },
    ]);

    const h = section('hooks');
    const hooksChanges = diffSection(h, h.resolve(before), h.resolve(after));
    expect(hooksChanges).toEqual([
      { key: 'custom_instructions', before: '(not set)', after: 'be brief' },
    ]);
  });
});

describe('summarize', () => {
  it('produces a non-empty one-liner per section reflecting current values', () => {
    const raw = materializedConfig();
    for (const s of SETTINGS_SECTIONS) {
      const line = s.summarize(raw);
      expect(line.length).toBeGreaterThan(0);
      expect(line).not.toContain('\n');
    }
    expect(section('watcher').summarize(raw)).toContain('off');
    raw.settings.watcher.enabled = true;
    expect(section('watcher').summarize(raw)).toContain('on');
  });
});
