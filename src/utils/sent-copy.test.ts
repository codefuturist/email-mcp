import type { SendResult, SentCopy } from '../types/index.js';
import sentCopyNote from './sent-copy.js';

function resultWith(sentCopy: SentCopy): SendResult {
  return { messageId: '<test@example.com>', status: 'sent', sentCopy };
}

describe('sentCopyNote', () => {
  it('names the folder a filed copy landed in', () => {
    const note = sentCopyNote(resultWith({ kind: 'filed', path: 'INBOX.Sent Messages' }));

    expect(note).toContain('INBOX.Sent Messages');
    expect(note).not.toContain('⚠️');
  });

  // Gmail files sent mail itself, so the copy is skipped on purpose there. Warning
  // that the message is not in the mailbox would be false on every send.
  it('does not alarm when the copy was skipped on purpose', () => {
    const note = sentCopyNote(resultWith({ kind: 'skipped' }));

    expect(note).not.toContain('⚠️');
    expect(note).not.toContain('not in your mailbox');
  });

  it('alarms with the reason when filing the copy failed', () => {
    const note = sentCopyNote(resultWith({ kind: 'failed', error: 'Mailbox does not exist' }));

    expect(note).toContain('⚠️');
    expect(note).toContain('Mailbox does not exist');
    expect(note).toContain('not in your mailbox');
  });

  // Typed by SentCopy['kind'], so a fourth variant fails `tsc` right here until
  // someone decides what it should say. That is the whole point of the union.
  const everyKind: Record<SentCopy['kind'], SentCopy> = {
    filed: { kind: 'filed', path: 'INBOX.Sent' },
    skipped: { kind: 'skipped' },
    failed: { kind: 'failed', error: 'boom' },
  };

  it.each(Object.entries(everyKind))('says something about a %s copy', (_kind, sentCopy) => {
    expect(sentCopyNote(resultWith(sentCopy)).trim()).not.toBe('');
  });
});
