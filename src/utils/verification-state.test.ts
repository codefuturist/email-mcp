import fs from 'node:fs/promises';

const { STATE_FILE } = vi.hoisted(() => ({
  STATE_FILE: `${process.env.TMPDIR ?? '/tmp'}/email-mcp-vitest-${process.pid}-verification-state.json`,
}));

vi.mock('../config/xdg.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config/xdg.js')>()),
  VERIFICATION_STATE_FILE: STATE_FILE,
}));

import { isVerificationProcessed, markVerificationProcessed } from './verification-state.js';

describe('verification-state', () => {
  afterEach(async () => {
    await fs.rm(STATE_FILE, { force: true });
    await fs.rm(`${STATE_FILE}.lock`, { force: true });
  });

  it('marks and recalls a processed message', async () => {
    expect(await isVerificationProcessed('work', 'INBOX', '4242')).toBe(false);

    await markVerificationProcessed('work', 'INBOX', '4242', true);

    expect(await isVerificationProcessed('work', 'INBOX', '4242')).toBe(true);
  });

  it('keys by mailbox — the same UID in another folder is unprocessed', async () => {
    await markVerificationProcessed('work', 'INBOX', '4242', false);

    expect(await isVerificationProcessed('work', 'Archive', '4242')).toBe(false);
  });

  it('prunes entries older than the retention window on write', async () => {
    const stale = new Date(Date.now() - 72 * 3600 * 1000).toISOString();
    await fs.writeFile(
      STATE_FILE,
      JSON.stringify({ processedEmails: { work__INBOX__1: { processedAt: stale, found: true } } }),
      'utf8',
    );

    await markVerificationProcessed('work', 'INBOX', '2', true);

    expect(await isVerificationProcessed('work', 'INBOX', '1')).toBe(false);
    expect(await isVerificationProcessed('work', 'INBOX', '2')).toBe(true);
  });
});
