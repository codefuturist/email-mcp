/**
 * Human-readable note about the Sent copy that accompanies every send result.
 */

import type { SendResult } from '../types/index.js';

export default function sentCopyNote(result: SendResult): string {
  const copy = result.sentCopy;

  switch (copy.kind) {
    case 'filed':
      return `\nCopy filed in: ${copy.path}`;
    case 'skipped':
      return '\nNo copy filed by this server — it files sent mail itself, or save_to_sent is off.';
    case 'failed':
      // Say it out loud. A send that leaves no record looks identical to one that
      // does, and the difference only surfaces weeks later when someone looks.
      return `\n⚠️ No copy filed in Sent (${copy.error}) — this message is not in your mailbox.`;
    default: {
      const exhaustive: never = copy;
      return exhaustive;
    }
  }
}
