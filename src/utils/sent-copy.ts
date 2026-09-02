/**
 * Human-readable note about the Sent copy that accompanies every send result.
 */

import type { SendResult } from '../types/index.js';

export default function sentCopyNote(result: SendResult): string {
  if (result.archivedTo) {
    return `\nCopy filed in: ${result.archivedTo}`;
  }

  // Say it out loud. A send that leaves no record looks identical to one that
  // does, and the difference only surfaces weeks later when someone looks.
  return `\n⚠️ No copy filed in Sent${result.archiveError ? ` (${result.archiveError})` : ''} — this message is not in your mailbox.`;
}
