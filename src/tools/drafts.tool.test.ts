import type ImapService from '../services/imap.service.js';
import type SmtpService from '../services/smtp.service.js';
import registerDraftTools from './drafts.tool.js';

vi.mock('../safety/audit.js', () => ({ default: { log: vi.fn().mockResolvedValue(undefined) } }));

describe('send_draft outcome', () => {
  it('reports delivery success and warns against resending when cleanup failed', async () => {
    const server = { registerTool: vi.fn() };
    const smtp = {
      sendDraft: vi.fn().mockResolvedValue({
        messageId: '<sent@example.test>',
        status: 'sent',
        sentCopy: { kind: 'skipped' },
        draftCleanup: { kind: 'failed', error: 'IMAP unavailable' },
      }),
    };
    registerDraftTools(
      server as unknown as Parameters<typeof registerDraftTools>[0],
      {} as ImapService,
      smtp as unknown as SmtpService,
    );
    const handler = server.registerTool.mock.calls.find((call) => call[0] === 'send_draft')![2];
    const result = await handler({ account: 'test', id: 7 });
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain('Draft sent');
    expect(result.content[0].text).toContain('do not resend');
    expect(result.content[0].text).not.toContain('Draft removed');
  });
});
