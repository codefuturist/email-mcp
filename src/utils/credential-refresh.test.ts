import type { AccountConfig } from '../types/index.js';
import { refreshAccountSecret } from './credential-refresh.js';

const base: AccountConfig = {
  name: 'pandia',
  email: 'me@example.com',
  username: 'me@example.com',
  password: 'old',
  imap: { host: '127.0.0.1', port: 1143, tls: false, starttls: true, verifySsl: false },
  smtp: { host: '127.0.0.1', port: 1025, tls: false, starttls: true, verifySsl: false },
};

describe('refreshAccountSecret', () => {
  afterEach(() => {
    delete process.env.REFRESH_TEST_PW;
  });

  it('re-resolves the reference in place and reports the change', async () => {
    process.env.REFRESH_TEST_PW = 'new';
    const account: AccountConfig = { ...base, password: 'old', passwordRef: 'env:REFRESH_TEST_PW' };

    expect(await refreshAccountSecret(account)).toBe(true);

    // Mutated in place on purpose: the watcher and the connection manager
    // hold this same object, so both see the rotated secret.
    expect(account.password).toBe('new');
  });

  it('reports no change when the resolved value is the same', async () => {
    process.env.REFRESH_TEST_PW = 'same';
    const account: AccountConfig = {
      ...base,
      password: 'same',
      passwordRef: 'env:REFRESH_TEST_PW',
    };

    expect(await refreshAccountSecret(account)).toBe(false);
    expect(account.password).toBe('same');
  });

  it('does nothing for a literal password (no reference to re-read)', async () => {
    const account: AccountConfig = { ...base, password: 'literal' };

    expect(await refreshAccountSecret(account)).toBe(false);
    expect(account.password).toBe('literal');
  });
});
