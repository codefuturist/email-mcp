import type { AccountConfig } from '../types/index.js';
import {
  authFailureHint,
  describeAuthFailure,
  isAuthFailure,
  withAuthGuidance,
} from './auth-error.js';

function account(overrides: Partial<AccountConfig> = {}): AccountConfig {
  return {
    name: 'personal',
    email: 'someone@gmail.com',
    username: 'someone@gmail.com',
    password: 'hunter2',
    imap: { host: 'imap.gmail.com', port: 993, tls: true, starttls: false, verifySsl: true },
    smtp: { host: 'smtp.gmail.com', port: 465, tls: true, starttls: false, verifySsl: true },
    ...overrides,
  } as AccountConfig;
}

/** nodemailer wraps a 535 reply like this. */
function smtpAuthError() {
  return Object.assign(new Error('Invalid login: 535-5.7.8 Username and Password not accepted'), {
    code: 'EAUTH',
    responseCode: 535,
  });
}

/** imapflow flags a rejected LOGIN like this. */
function imapAuthError() {
  return Object.assign(new Error('Authentication failed'), {
    authenticationFailed: true,
    responseStatus: 'NO',
  });
}

describe('isAuthFailure', () => {
  it('recognizes a nodemailer EAUTH / 535', () => {
    expect(isAuthFailure(smtpAuthError())).toBe(true);
  });

  it('recognizes an imapflow authentication failure', () => {
    expect(isAuthFailure(imapAuthError())).toBe(true);
  });

  it('recognizes an AUTHENTICATIONFAILED response code', () => {
    expect(isAuthFailure(Object.assign(new Error('x'), { code: 'AUTHENTICATIONFAILED' }))).toBe(
      true,
    );
  });

  it('recognizes the failure by its server text alone', () => {
    expect(isAuthFailure(new Error('LOGIN failed: invalid credentials'))).toBe(true);
  });

  it('leaves unreachable-server errors alone', () => {
    expect(
      isAuthFailure(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })),
    ).toBe(false);
    expect(
      isAuthFailure(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })),
    ).toBe(false);
    expect(isAuthFailure(new Error('self signed certificate in certificate chain'))).toBe(false);
  });

  it('is safe on non-errors', () => {
    expect(isAuthFailure(undefined)).toBe(false);
    expect(isAuthFailure('nope')).toBe(false);
  });
});

describe('describeAuthFailure', () => {
  it("quotes the provider's app-password requirement for Gmail", () => {
    const message = describeAuthFailure(smtpAuthError(), account(), 'SMTP');

    expect(message).toContain('SMTP authentication failed for account "personal"');
    expect(message).toContain('smtp.gmail.com:465');
    expect(message).toContain('Gmail: Requires an App Password');
    // The server's own words survive, so a provider-specific reason is not lost.
    expect(message).toContain('535-5.7.8 Username and Password not accepted');
    expect(message).toContain('email-mcp account edit personal');
    // Health output is read by agents and scripts as often as by a human at a
    // TTY, so the non-interactive remedy must be in the same breath.
    expect(message).toContain('email-mcp account set-secret personal --stdin');
  });

  it('names the IMAP host when the IMAP leg failed', () => {
    const message = describeAuthFailure(imapAuthError(), account(), 'IMAP');

    expect(message).toContain('IMAP authentication failed');
    expect(message).toContain('imap.gmail.com:993');
  });

  it('points OAuth2 accounts at their refresh token instead of a password', () => {
    const oauthAccount = account({
      oauth2: {
        provider: 'google',
        clientId: 'id',
        clientSecret: 'secret',
        refreshToken: 'token',
      },
    } as Partial<AccountConfig>);

    const message = describeAuthFailure(smtpAuthError(), oauthAccount, 'SMTP');

    expect(message).toContain('refresh token');
    expect(message).toContain('accounts.personal.oauth2');
    expect(message).not.toContain('App Password');
  });

  it('warns Microsoft 365 users that password auth is usually disabled', () => {
    const outlook = account({
      email: 'someone@outlook.com',
      smtp: {
        host: 'smtp.office365.com',
        port: 587,
        tls: false,
        starttls: true,
        verifySsl: true,
      },
    } as Partial<AccountConfig>);

    expect(describeAuthFailure(smtpAuthError(), outlook, 'SMTP')).toContain('OAuth2');
  });

  it('falls back to generic advice for an unknown provider', () => {
    const custom = account({
      email: 'me@example.test',
      smtp: { host: 'mail.example.test', port: 465, tls: true, starttls: false, verifySsl: true },
    } as Partial<AccountConfig>);

    expect(describeAuthFailure(smtpAuthError(), custom, 'SMTP')).toContain('app password');
  });
});

describe('authFailureHint', () => {
  it('gives the remedy alone, without repeating the host or server text', () => {
    const hint = authFailureHint(smtpAuthError(), account());

    expect(hint).toContain('Requires an App Password');
    expect(hint).toContain('email-mcp account edit personal');
    expect(hint).toContain('email-mcp account set-secret personal --stdin');
    // The caller's spinner line already shows these.
    expect(hint).not.toContain('smtp.gmail.com');
    expect(hint).not.toContain('535-5.7.8');
    // Must stay on one line to sit inside a clack log line.
    expect(hint).not.toContain('\n');
  });

  it('is undefined when the server was simply unreachable', () => {
    const unreachable = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
    expect(authFailureHint(unreachable, account())).toBeUndefined();
  });
});

describe('withAuthGuidance', () => {
  it('passes a successful call straight through', async () => {
    await expect(withAuthGuidance(account(), 'IMAP', async () => 'ok')).resolves.toBe('ok');
  });

  it('rewrites a credentials rejection and keeps the original as cause', async () => {
    const original = smtpAuthError();
    const attempt = withAuthGuidance(account(), 'SMTP', () => Promise.reject(original));

    await expect(attempt).rejects.toThrow('Requires an App Password');
    await expect(attempt).rejects.toHaveProperty('cause', original);
  });

  it('rethrows a connection failure untouched', async () => {
    const original = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

    await expect(withAuthGuidance(account(), 'SMTP', () => Promise.reject(original))).rejects.toBe(
      original,
    );
  });
});
