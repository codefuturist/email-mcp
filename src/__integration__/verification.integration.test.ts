import { scanRecent } from '../services/verification-catcher.service.js';
import type { TestServices } from './helpers/index.js';
import {
  buildSecondTestAccount,
  buildTestAccount,
  createTestServices,
  seedEmail,
  waitForDelivery,
} from './helpers/index.js';

// Runs against the second GreenMail account (bob) so accumulated mail from
// other suites in the shared test inbox cannot produce accidental hits.
const ACCOUNT = 'integration-2';
const LOOKBACK_MS = 15 * 60_000;

describe('Verification scan (GreenMail)', () => {
  let services: TestServices;

  beforeAll(async () => {
    services = createTestServices(buildTestAccount(), buildSecondTestAccount());
  });

  afterAll(async () => {
    await services.connections.closeAll();
  });

  it('rejects an order confirmation despite its 6-digit number', async () => {
    await seedEmail({
      to: 'bob@localhost',
      subject: 'Your order #482913 has shipped',
      text: 'Track your order 482913 with tracking number 1Z999AA10123456784.',
    });
    await waitForDelivery();

    const hit = await scanRecent(services.imapService, [ACCOUNT], 'INBOX', LOOKBACK_MS);

    expect(hit).toBeUndefined();
  });

  it('finds an English verification code end-to-end', async () => {
    await seedEmail({
      to: 'bob@localhost',
      subject: 'Your GitHub verification code',
      text: 'Your verification code is 482913. It expires in 10 minutes.',
    });
    await waitForDelivery();

    const hit = await scanRecent(services.imapService, [ACCOUNT], 'INBOX', LOOKBACK_MS);

    expect(hit?.kind).toBe('code');
    expect(hit?.value).toBe('482913');
    expect(hit?.account).toBe(ACCOUNT);
  });

  it('finds a German Bestätigungscode', async () => {
    await seedEmail({
      to: 'bob@localhost',
      subject: 'Ihr Sicherheitscode',
      text: 'Ihr Bestätigungscode lautet 348290. Er ist 10 Minuten gültig.',
    });
    await waitForDelivery();

    const hit = await scanRecent(services.imapService, [ACCOUNT], 'INBOX', LOOKBACK_MS);

    expect(hit?.kind).toBe('code');
    expect(hit?.value).toBe('348290');
  });

  it('finds a sign-in link in a plain-text body', async () => {
    await seedEmail({
      to: 'bob@localhost',
      subject: 'Sign in to Notion',
      text: 'Click to sign in: https://auth.example.com/magic?token=Mm1Nn2Oo3Pp4Qq5Rr6Ss7Tt8.',
    });
    await waitForDelivery();

    const hit = await scanRecent(services.imapService, [ACCOUNT], 'INBOX', LOOKBACK_MS);

    expect(hit?.kind).toBe('link');
    expect(hit?.value).toBe('https://auth.example.com/magic?token=Mm1Nn2Oo3Pp4Qq5Rr6Ss7Tt8');
  });

  it('finds a magic link in an HTML-only body', async () => {
    // Short stub text + much larger HTML triggers selectBodyPart's
    // stub-plain heuristic, so getEmail yields bodyHtml — the anchor path.
    await seedEmail({
      to: 'bob@localhost',
      subject: 'Confirm your account',
      text: 'Open the HTML version.',
      html:
        '<html><body><table><tr><td style="padding:24px;font-family:sans-serif">' +
        '<p>Welcome! Please confirm your account to get started with our service.</p>' +
        '<p style="margin:24px 0">' +
        '<a href="https://accounts.example.com/verify?token=Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8" ' +
        'style="background:#000;color:#fff;padding:12px 20px">Confirm account</a></p>' +
        '<p>If you did not request this, ignore this mail.</p>' +
        '<p><a href="https://example.com/unsubscribe?u=42">Unsubscribe</a></p>' +
        '</td></tr></table></body></html>',
    });
    await waitForDelivery();

    const hit = await scanRecent(services.imapService, [ACCOUNT], 'INBOX', LOOKBACK_MS);

    expect(hit?.kind).toBe('link');
    expect(hit?.value).toBe('https://accounts.example.com/verify?token=Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8');
  });
});
