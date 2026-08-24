/**
 * Shared formatting for the Sent-mailbox-copy note appended to send/reply/
 * forward/draft/template tool responses.
 */

import type { SendResult } from '../types/index.js';

/**
 * A trailing note describing whether a copy of the sent message was saved
 * to the account's Sent mailbox — empty string when there's nothing to add.
 * @param result - The result returned by an SmtpService send method.
 */
function formatSentCopyNote(result: SendResult): string {
  if (!result.sentCopy) return '';
  if (result.sentCopy.saved) return `\nSaved to: ${result.sentCopy.mailbox}`;
  return `\n⚠️ ${result.sentCopy.warning ?? 'Could not save a copy to Sent.'}`;
}

export default formatSentCopyNote;
