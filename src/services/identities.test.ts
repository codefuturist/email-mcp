import type { AccountConfig, Email } from '../types/index.js';
import {
  findIdentity,
  formatSender,
  identityForReply,
  isOwnAddress,
  listIdentities,
  resolveIdentity,
} from './identities.js';

function account(overrides: Partial<AccountConfig> = {}): AccountConfig {
  return {
    name: 'work',
    email: 'me@example.com',
    fullName: 'Me',
    username: 'me@example.com',
    sentMailbox: 'Sent',
    identities: [
      { email: 'sales@example.com', fullName: 'Sales Team', sentMailbox: 'Sales/Sent' },
      { email: 'alias@example.org' },
    ],
    imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
    smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
    ...overrides,
  };
}

function original(overrides: Partial<Email> = {}): Email {
  return {
    id: '1',
    subject: 'Hi',
    from: { address: 'them@example.net' },
    to: [],
    date: '2026-01-01',
    seen: false,
    flagged: false,
    answered: false,
    hasAttachments: false,
    labels: [],
    messageId: '<orig@example.net>',
    attachments: [],
    headers: {},
    ...overrides,
  } as Email;
}

describe('listIdentities', () => {
  it('puts the primary identity first, then the configured aliases', () => {
    expect(listIdentities(account()).map((i) => i.email)).toEqual([
      'me@example.com',
      'sales@example.com',
      'alias@example.org',
    ]);
  });

  it('drops an alias that repeats the primary or another alias, in any case', () => {
    const acc = account({
      identities: [{ email: 'ME@example.com' }, { email: 'a@x.test' }, { email: 'A@X.test' }],
    });
    expect(listIdentities(acc).map((i) => i.email)).toEqual(['me@example.com', 'a@x.test']);
  });

  it('is just the primary when no identities are configured', () => {
    expect(listIdentities(account({ identities: undefined }))).toEqual([
      { email: 'me@example.com', fullName: 'Me', sentMailbox: 'Sent' },
    ]);
  });
});

describe('resolveIdentity', () => {
  it('defaults to the primary identity', () => {
    expect(resolveIdentity(account(), undefined).email).toBe('me@example.com');
    expect(resolveIdentity(account(), '  ').email).toBe('me@example.com');
  });

  it('returns a configured alias, matching case-insensitively', () => {
    const identity = resolveIdentity(account(), 'Sales@Example.com');
    expect(identity).toEqual({
      email: 'sales@example.com',
      fullName: 'Sales Team',
      sentMailbox: 'Sales/Sent',
    });
  });

  // No free-form From: an address that is not configured must never reach
  // the header, however plausible it looks.
  it('rejects an address that is not a configured identity, naming the allowed ones', () => {
    expect(() => resolveIdentity(account(), 'ceo@example.com')).toThrow(
      /not a sender identity.*me@example\.com, sales@example\.com, alias@example\.org/,
    );
  });
});

describe('findIdentity / isOwnAddress', () => {
  it('finds primary and aliases, not strangers', () => {
    expect(findIdentity(account(), 'alias@example.org')?.email).toBe('alias@example.org');
    expect(findIdentity(account(), undefined)).toBeUndefined();
    expect(isOwnAddress(account(), 'ME@EXAMPLE.COM')).toBe(true);
    expect(isOwnAddress(account(), 'them@example.net')).toBe(false);
  });
});

// Mirrors Thunderbird for Android / K-9 Mail: To, then Cc, then the delivery
// headers, first match wins, else the default identity.
describe('identityForReply', () => {
  it('picks the alias the original was sent To', () => {
    const msg = original({ to: [{ address: 'friend@x.test' }, { address: 'sales@example.com' }] });
    expect(identityForReply(account(), msg).email).toBe('sales@example.com');
  });

  it('prefers a To match over a Cc match', () => {
    const msg = original({
      to: [{ address: 'alias@example.org' }],
      cc: [{ address: 'sales@example.com' }],
    });
    expect(identityForReply(account(), msg).email).toBe('alias@example.org');
  });

  it('falls back to Cc, then to the delivery headers (Bcc / list mail)', () => {
    expect(
      identityForReply(
        account(),
        original({ to: [{ address: 'list@x.test' }], cc: [{ address: 'sales@example.com' }] }),
      ).email,
    ).toBe('sales@example.com');

    const viaBcc = original({
      to: [{ address: 'list@x.test' }],
      headers: { 'delivered-to': 'Alias@Example.org' },
    });
    expect(identityForReply(account(), viaBcc).email).toBe('alias@example.org');

    const viaOriginalTo = original({
      to: [{ address: 'list@x.test' }],
      headers: {
        'x-original-to': '"Sales" <sales@example.com>',
        'delivered-to': 'alias@example.org',
      },
    });
    expect(identityForReply(account(), viaOriginalTo).email).toBe('sales@example.com');
  });

  it('uses the primary identity when nothing matches', () => {
    const msg = original({ to: [{ address: 'list@x.test' }] });
    expect(identityForReply(account(), msg).email).toBe('me@example.com');
  });

  it('copes with an original that carries no headers map', () => {
    const msg = original({ to: [{ address: 'list@x.test' }], headers: undefined });
    expect(identityForReply(account(), msg).email).toBe('me@example.com');
  });
});

describe('formatSender', () => {
  it('quotes the display name, or uses the bare address without one', () => {
    expect(formatSender({ email: 'a@x.test', fullName: 'A B' })).toBe('"A B" <a@x.test>');
    expect(formatSender({ email: 'a@x.test' })).toBe('a@x.test');
  });
});
