import type { ImapFlow } from 'imapflow';
import { detectLabelStrategy } from './label-strategy.js';

/** ImapFlow throws Error('Command failed') and puts the detail on `.response`. */
function rejection(response: string): Error & { response: string } {
  return Object.assign(new Error('Command failed'), { response });
}

/** A client that looks like ProtonMail: a \Noselect "Labels" folder. */
function protonClient(overrides: Record<string, unknown> = {}) {
  return {
    capabilities: new Map<string, boolean>(),
    list: vi
      .fn()
      .mockResolvedValue([{ name: 'Labels', path: 'Labels', flags: new Set(['\\Noselect']) }]),
    getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
    fetchOne: vi.fn().mockResolvedValue({ envelope: { messageId: '<a@b>' } }),
    search: vi.fn().mockResolvedValue([]),
    messageCopy: vi.fn().mockResolvedValue({ uidMap: new Map() }),
    messageDelete: vi.fn().mockResolvedValue(true),
    mailboxCreate: vi.fn().mockResolvedValue({ path: 'x' }),
    mailboxDelete: vi.fn().mockResolvedValue({ path: 'x' }),
    ...overrides,
  } as unknown as ImapFlow;
}

describe('ProtonMail label strategy', () => {
  it('explains that a label must exist before it can be applied', async () => {
    const client = protonClient({
      messageCopy: vi.fn().mockRejectedValue(rejection('12 NO no such mailbox')),
    });
    const strategy = await detectLabelStrategy(client);

    // "COPY failed" leaves the caller guessing; on this server a label is a
    // folder, so the actionable next step is create_label.
    await expect(strategy.addLabel(client, '1', 'INBOX', 'Missing')).rejects.toThrow(
      /create_label/i,
    );
  });

  it('surfaces the server reason when the label folder cannot be opened', async () => {
    const client = protonClient({
      getMailboxLock: vi
        .fn()
        .mockResolvedValueOnce({ release: vi.fn() }) // source mailbox opens
        .mockRejectedValue(rejection('13 NO mailbox does not exist')),
    });
    const strategy = await detectLabelStrategy(client);

    await expect(strategy.removeLabel(client, '1', 'INBOX', 'Missing')).rejects.toThrow(
      /mailbox does not exist/,
    );
  });

  it('surfaces the server reason when creating a label fails', async () => {
    const client = protonClient({
      mailboxCreate: vi.fn().mockRejectedValue(rejection('14 NO name already in use')),
    });
    const strategy = await detectLabelStrategy(client);

    await expect(strategy.createLabel(client, 'Dup')).rejects.toThrow(/name already in use/);
  });
});
