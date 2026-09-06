import type { AccountConfig } from '../types/index.js';
import buildImapAuth from './auth.js';

const passwordAccount = {
  name: 'plain',
  email: 'a@example.com',
  username: 'a@example.com',
  password: 'secret',
} as AccountConfig;

const oauthAccount = {
  name: 'work',
  email: 'b@example.com',
  username: 'b@example.com',
  oauth2: { provider: 'google', clientId: 'id', clientSecret: 's', refreshToken: 'r' },
} as AccountConfig;

describe('buildImapAuth', () => {
  it('uses the password for a password account', async () => {
    expect(await buildImapAuth(passwordAccount)).toEqual({
      user: 'a@example.com',
      pass: 'secret',
    });
  });

  it('ignores the OAuth service when the account does not use OAuth', async () => {
    const oauthService = { getAccessToken: vi.fn() };

    await buildImapAuth(passwordAccount, oauthService as never);

    expect(oauthService.getAccessToken).not.toHaveBeenCalled();
  });

  // The regression this exists for: the IDLE watcher used to send
  // account.password as the bearer token, which is undefined for an OAuth2
  // account — so IDLE authenticated with nothing and failed silently.
  it('fetches a live access token for an OAuth account', async () => {
    const oauthService = { getAccessToken: vi.fn().mockResolvedValue('ya29.token') };

    const auth = await buildImapAuth(oauthAccount, oauthService as never);

    expect(auth).toEqual({ user: 'b@example.com', accessToken: 'ya29.token' });
    expect(auth).not.toHaveProperty('pass');
  });

  it('never passes a password as an OAuth bearer token', async () => {
    const hybrid = { ...oauthAccount, password: 'not-a-token' } as AccountConfig;
    const oauthService = { getAccessToken: vi.fn().mockResolvedValue('ya29.token') };

    const auth = await buildImapAuth(hybrid, oauthService as never);

    expect(auth.accessToken).toBe('ya29.token');
    expect(auth.accessToken).not.toBe('not-a-token');
  });

  it('fails loudly when an OAuth account has no OAuth service wired', async () => {
    await expect(buildImapAuth(oauthAccount)).rejects.toThrow('no OAuth service is available');
  });
});
