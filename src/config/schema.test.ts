import {
  AccountConfigSchema,
  AppConfigFileSchema,
  ImapConfigSchema,
  SettingsSchema,
  SmtpConfigSchema,
} from './schema.js';

const validImap = { host: 'imap.example.com' };
const validSmtp = { host: 'smtp.example.com' };

function validAccount(overrides = {}) {
  return {
    name: 'test',
    email: 'user@example.com',
    password: 'secret',
    imap: validImap,
    smtp: validSmtp,
    ...overrides,
  };
}

describe('ImapConfigSchema', () => {
  it('applies default port of 993', () => {
    const result = ImapConfigSchema.parse({ host: 'imap.example.com' });
    expect(result.port).toBe(993);
  });

  it('rejects port 0', () => {
    expect(() => ImapConfigSchema.parse({ host: 'imap.example.com', port: 0 })).toThrow();
  });

  it('rejects port 65536', () => {
    expect(() => ImapConfigSchema.parse({ host: 'imap.example.com', port: 65536 })).toThrow();
  });

  it('accepts valid port', () => {
    const result = ImapConfigSchema.parse({ host: 'imap.example.com', port: 143 });
    expect(result.port).toBe(143);
  });
});

describe('SmtpConfigSchema', () => {
  it('applies default port of 465', () => {
    const result = SmtpConfigSchema.parse({ host: 'smtp.example.com' });
    expect(result.port).toBe(465);
  });

  it('rejects port 0', () => {
    expect(() => SmtpConfigSchema.parse({ host: 'smtp.example.com', port: 0 })).toThrow();
  });

  it('rejects port 65536', () => {
    expect(() => SmtpConfigSchema.parse({ host: 'smtp.example.com', port: 65536 })).toThrow();
  });

  it('applies pool defaults', () => {
    const result = SmtpConfigSchema.parse({ host: 'smtp.example.com' });
    expect(result.pool).toEqual({
      enabled: true,
      max_connections: 1,
      max_messages: 100,
    });
  });
});

describe('AccountConfigSchema', () => {
  it('accepts valid minimal config with password', () => {
    const result = AccountConfigSchema.parse(validAccount());
    expect(result.name).toBe('test');
    expect(result.email).toBe('user@example.com');
  });

  it('accepts valid config with oauth2 instead of password', () => {
    const result = AccountConfigSchema.parse(
      validAccount({
        password: undefined,
        oauth2: {
          provider: 'google',
          client_id: 'id',
          client_secret: 'secret',
          refresh_token: 'token',
        },
      }),
    );
    expect(result.oauth2?.provider).toBe('google');
  });

  it('rejects when neither password nor oauth2 provided', () => {
    expect(() => AccountConfigSchema.parse(validAccount({ password: undefined }))).toThrow(
      'password or oauth2',
    );
  });

  it('rejects missing name', () => {
    expect(() => AccountConfigSchema.parse(validAccount({ name: '' }))).toThrow();
  });

  it('rejects invalid email format', () => {
    expect(() => AccountConfigSchema.parse(validAccount({ email: 'not-an-email' }))).toThrow();
  });

  it('rejects missing imap', () => {
    expect(() => AccountConfigSchema.parse({ ...validAccount(), imap: undefined })).toThrow();
  });

  it('rejects missing smtp', () => {
    expect(() => AccountConfigSchema.parse({ ...validAccount(), smtp: undefined })).toThrow();
  });
});

describe('SettingsSchema', () => {
  it('applies default rate_limit of 10', () => {
    const result = SettingsSchema.parse({});
    expect(result.rate_limit).toBe(10);
  });

  it('applies default read_only of false', () => {
    const result = SettingsSchema.parse({});
    expect(result.read_only).toBe(false);
  });

  it('accepts custom values', () => {
    const result = SettingsSchema.parse({ rate_limit: 5, read_only: true });
    expect(result.rate_limit).toBe(5);
    expect(result.read_only).toBe(true);
  });
});

describe('verification settings', () => {
  const expectedDefaults = {
    enabled: true,
    auto_copy: true,
    confirm_copy: false,
    notify: true,
    copy_links: true,
    link_action: 'open',
    clear_after_seconds: 60,
    max_age_minutes: 10,
    accounts: [],
    sender_allowlist: [],
    sender_denylist: [],
  };

  it('applies verification defaults via SettingsSchema', () => {
    const result = SettingsSchema.parse({});
    expect(result.verification).toEqual(expectedDefaults);
  });

  // Guards the duplicated default literal in AppConfigFileSchema — the two
  // blocks must stay in lockstep.
  it('applies verification defaults when settings is absent entirely', () => {
    const result = AppConfigFileSchema.parse({ accounts: [validAccount()] });
    expect(result.settings.verification).toEqual(expectedDefaults);
  });

  it('rejects clear_after_seconds beyond one hour', () => {
    expect(() => SettingsSchema.parse({ verification: { clear_after_seconds: 3601 } })).toThrow();
  });

  it('rejects an unknown link_action', () => {
    expect(() => SettingsSchema.parse({ verification: { link_action: 'paste' } })).toThrow();
  });
});

describe('server settings', () => {
  it('applies server defaults via SettingsSchema and AppConfigFileSchema', () => {
    const expected = {
      host: '127.0.0.1',
      port: 8080,
      path: '/mcp',
      token: '',
      allowed_hosts: [],
    };
    expect(SettingsSchema.parse({}).server).toEqual(expected);
    expect(AppConfigFileSchema.parse({ accounts: [validAccount()] }).settings.server).toEqual(
      expected,
    );
  });

  it('rejects out-of-range ports', () => {
    expect(() => SettingsSchema.parse({ server: { port: 0 } })).toThrow();
    expect(() => SettingsSchema.parse({ server: { port: 65536 } })).toThrow();
  });
});

describe('AppConfigFileSchema', () => {
  it('accepts valid config with one account', () => {
    const result = AppConfigFileSchema.parse({ accounts: [validAccount()] });
    expect(result.accounts).toHaveLength(1);
  });

  it('requires at least one account', () => {
    expect(() => AppConfigFileSchema.parse({ accounts: [] })).toThrow('At least one account');
  });

  it('applies settings defaults when not provided', () => {
    const result = AppConfigFileSchema.parse({ accounts: [validAccount()] });
    expect(result.settings.rate_limit).toBe(10);
    expect(result.settings.read_only).toBe(false);
  });

  it('rejects accounts with invalid email', () => {
    expect(() =>
      AppConfigFileSchema.parse({ accounts: [validAccount({ email: 'bad' })] }),
    ).toThrow();
  });
});

describe('send settings', () => {
  it('defaults max_attachment_mb to 25 when settings.send is absent', () => {
    const result = AppConfigFileSchema.parse({ accounts: [validAccount()] });
    expect(result.settings.send).toEqual({ max_attachment_mb: 25, save_to_sent: false });
  });

  it('accepts an explicit max_attachment_mb', () => {
    const result = AppConfigFileSchema.parse({
      accounts: [validAccount()],
      settings: { send: { max_attachment_mb: 10 } },
    });
    expect(result.settings.send.max_attachment_mb).toBe(10);
  });

  it('accepts an optional per-account max_attachment_mb', () => {
    const result = AppConfigFileSchema.parse({
      accounts: [validAccount({ max_attachment_mb: 40 })],
    });
    expect(result.accounts[0]!.max_attachment_mb).toBe(40);
  });

  it('leaves the per-account max_attachment_mb unset by default', () => {
    const result = AppConfigFileSchema.parse({ accounts: [validAccount()] });
    expect(result.accounts[0]!.max_attachment_mb).toBeUndefined();
  });

  it('rejects a non-positive per-account max_attachment_mb', () => {
    expect(() =>
      AppConfigFileSchema.parse({
        accounts: [validAccount({ max_attachment_mb: 0 })],
      }),
    ).toThrow();
  });
});

describe('attachments settings', () => {
  it('defaults auto_download to true when settings.attachments is absent', () => {
    const result = AppConfigFileSchema.parse({ accounts: [validAccount()] });
    expect(result.settings.attachments).toEqual({ auto_download: true });
  });

  it('accepts disabling auto_download', () => {
    const result = AppConfigFileSchema.parse({
      accounts: [validAccount()],
      settings: { attachments: { auto_download: false } },
    });
    expect(result.settings.attachments.auto_download).toBe(false);
  });

  it('rejects a non-positive max_attachment_mb', () => {
    expect(() =>
      AppConfigFileSchema.parse({
        accounts: [validAccount()],
        settings: { send: { max_attachment_mb: 0 } },
      }),
    ).toThrow();
  });
});

describe('cache window default', () => {
  it('mirrors the whole mailbox by default so cached listings are complete', () => {
    const parsed = SettingsSchema.parse({});

    // A bounded window makes the mirror a slice, and a slice cannot answer
    // "how many messages are there" — the read path then has to go live for
    // every listing, which defeats the cache. Envelopes are ~1 KB, so a full
    // envelope mirror of a 9k-message mailbox costs ~9 MB of a 500 MB budget.
    expect(parsed.cache.window_days).toBe(0);
  });
});

describe('credential alerts settings', () => {
  const expectedDefaults = {
    enabled: true,
    sound: true,
    remind_every_minutes: 0,
    webhook: false,
  };

  it('applies credential_alerts defaults via SettingsSchema', () => {
    expect(SettingsSchema.parse({}).credential_alerts).toEqual(expectedDefaults);
  });

  // Guards the duplicated default literal in AppConfigFileSchema.
  it('applies credential_alerts defaults when settings is absent entirely', () => {
    const result = AppConfigFileSchema.parse({ accounts: [validAccount()] });
    expect(result.settings.credential_alerts).toEqual(expectedDefaults);
  });

  it('bounds remind_every_minutes to 0..10080 (a week)', () => {
    const parse = (remind_every_minutes: number) =>
      SettingsSchema.parse({ credential_alerts: { remind_every_minutes } }).credential_alerts
        .remind_every_minutes;
    expect(() => parse(-1)).toThrow();
    expect(parse(0)).toBe(0);
    expect(parse(10080)).toBe(10080);
    expect(() => parse(10081)).toThrow();
  });

  it('lets an account opt out (or in) individually', () => {
    const optedOut = AppConfigFileSchema.parse({
      accounts: [{ ...validAccount(), credential_alerts: false }],
    });
    expect(optedOut.accounts[0]?.credential_alerts).toBe(false);

    const unset = AppConfigFileSchema.parse({ accounts: [validAccount()] });
    expect(unset.accounts[0]?.credential_alerts).toBeUndefined();
  });
});
