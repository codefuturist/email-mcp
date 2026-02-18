/**
 * Label strategy — provider-aware label operations.
 *
 * Three strategies handle the differences between email providers:
 * - ProtonMail Bridge: Labels are IMAP folders under "Labels/" prefix
 * - Gmail: Uses X-GM-LABELS extension via ImapFlow's useLabels option
 * - Standard IMAP: Uses RFC 5788 keywords (custom flags)
 */

import type { ImapFlow } from 'imapflow';
import type { LabelInfo, LabelStrategyType } from '../types/index.js';

// ---------------------------------------------------------------------------
// Strategy interface
// ---------------------------------------------------------------------------

export interface LabelStrategy {
  readonly type: LabelStrategyType;
  listLabels: (client: ImapFlow) => Promise<LabelInfo[]>;
  addLabel: (client: ImapFlow, emailId: string, mailbox: string, label: string) => Promise<void>;
  removeLabel: (client: ImapFlow, emailId: string, mailbox: string, label: string) => Promise<void>;
  createLabel: (client: ImapFlow, name: string) => Promise<void>;
  deleteLabel: (client: ImapFlow, name: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// ProtonMail: Labels are folders under "Labels/" prefix
// ---------------------------------------------------------------------------

const LABELS_PREFIX = 'Labels/';

function createProtonMailStrategy(): LabelStrategy {
  const type: LabelStrategyType = 'protonmail';

  return {
    type,

    listLabels: async (client) => {
      const mailboxes = await client.list();
      return mailboxes
        .filter((mb) => mb.path.startsWith(LABELS_PREFIX) && !mb.flags?.has('\\Noselect'))
        .map((mb) => ({
          name: mb.path.slice(LABELS_PREFIX.length),
          path: mb.path,
          strategy: type,
        }));
    },

    addLabel: async (client, emailId, mailbox, label) => {
      const targetPath = `${LABELS_PREFIX}${label}`;
      const lock = await client.getMailboxLock(mailbox);
      try {
        const result = await client.messageCopy(emailId, targetPath, { uid: true });
        if (!result) {
          throw new Error(
            `Server rejected adding label "${label}" (COPY to ${targetPath} failed).`,
          );
        }
      } finally {
        lock.release();
      }
    },

    removeLabel: async (client, emailId, mailbox, label) => {
      const labelPath = `${LABELS_PREFIX}${label}`;

      // Fetch Message-ID from source mailbox
      const srcLock = await client.getMailboxLock(mailbox);
      let messageId: string | undefined;
      try {
        const msg = await client.fetchOne(emailId, { envelope: true }, { uid: true });
        if (msg && typeof msg === 'object' && 'envelope' in msg) {
          const envelope = msg.envelope as { messageId?: string };
          messageId = envelope.messageId;
        }
      } finally {
        srcLock.release();
      }

      if (!messageId) {
        throw new Error('Could not retrieve Message-ID to locate email in label folder.');
      }

      // Find the email's UID inside the label folder and delete it
      const labelLock = await client.getMailboxLock(labelPath);
      try {
        const results = await client.search({ header: { 'message-id': messageId } }, { uid: true });
        if (!results || !Array.isArray(results) || results.length === 0) {
          throw new Error(`Email not found in label "${label}".`);
        }
        const deleteOps = results.map(async (uid) => {
          const ok = await client.messageDelete(String(uid), { uid: true });
          if (!ok) {
            throw new Error(`Server rejected removing label "${label}" for UID ${uid}.`);
          }
        });
        await Promise.all(deleteOps);
      } finally {
        labelLock.release();
      }
    },

    createLabel: async (client, name) => {
      await client.mailboxCreate(`${LABELS_PREFIX}${name}`);
    },

    deleteLabel: async (client, name) => {
      await client.mailboxDelete(`${LABELS_PREFIX}${name}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Gmail: X-GM-LABELS extension
// ---------------------------------------------------------------------------

function createGmailStrategy(): LabelStrategy {
  const type: LabelStrategyType = 'gmail';

  return {
    type,

    listLabels: async (client) => {
      const mailboxes = await client.list();
      function isUserLabel(mb: {
        flags?: Set<string>;
        specialUse?: string;
        path: string;
      }): boolean {
        return (
          !mb.flags?.has('\\Noselect') &&
          !mb.specialUse &&
          mb.path !== 'INBOX' &&
          !mb.path.startsWith('[Gmail]')
        );
      }
      return mailboxes
        .filter(isUserLabel)
        .map((mb) => ({ name: mb.name, path: mb.path, strategy: type }));
    },

    addLabel: async (client, emailId, mailbox, label) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const result = await client.messageFlagsAdd(emailId, [label], {
          uid: true,
          useLabels: true,
        });
        if (!result) {
          throw new Error(`Server rejected adding label "${label}".`);
        }
      } finally {
        lock.release();
      }
    },

    removeLabel: async (client, emailId, mailbox, label) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const result = await client.messageFlagsRemove(emailId, [label], {
          uid: true,
          useLabels: true,
        });
        if (!result) {
          throw new Error(`Server rejected removing label "${label}".`);
        }
      } finally {
        lock.release();
      }
    },

    createLabel: async (client, name) => {
      await client.mailboxCreate(name);
    },

    deleteLabel: async (client, name) => {
      await client.mailboxDelete(name);
    },
  };
}

// ---------------------------------------------------------------------------
// Standard IMAP: Keywords (custom flags via STORE)
// ---------------------------------------------------------------------------

function createKeywordStrategy(): LabelStrategy {
  const type: LabelStrategyType = 'keyword';

  return {
    type,

    listLabels: async (client) => {
      // IMAP keywords cannot be enumerated server-wide.
      // We sample the INBOX's PERMANENTFLAGS for known keywords.
      const lock = await client.getMailboxLock('INBOX');
      try {
        const status = client.mailbox;
        const keywords: LabelInfo[] = [];
        if (status && typeof status === 'object' && 'permanentFlags' in status) {
          const permFlags = status.permanentFlags as Set<string>;
          permFlags.forEach((flag) => {
            if (!flag.startsWith('\\')) {
              keywords.push({ name: flag, strategy: type });
            }
          });
        }
        return keywords;
      } finally {
        lock.release();
      }
    },

    addLabel: async (client, emailId, mailbox, label) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const result = await client.messageFlagsAdd(emailId, [label], { uid: true });
        if (!result) {
          throw new Error(`Server rejected adding keyword "${label}".`);
        }
      } finally {
        lock.release();
      }
    },

    removeLabel: async (client, emailId, mailbox, label) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const result = await client.messageFlagsRemove(emailId, [label], { uid: true });
        if (!result) {
          throw new Error(`Server rejected removing keyword "${label}".`);
        }
      } finally {
        lock.release();
      }
    },

    createLabel: async () => {
      // Keywords are auto-created on first use — no explicit creation needed.
    },

    deleteLabel: async () => {
      throw new Error(
        'IMAP keywords cannot be deleted server-wide. ' +
          'Remove the keyword from individual emails using remove_label instead.',
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Detection — auto-detect the best label strategy for an account
// ---------------------------------------------------------------------------

export async function detectLabelStrategy(client: ImapFlow): Promise<LabelStrategy> {
  // 1. Check for ProtonMail Bridge: "Labels" folder with \Noselect
  const mailboxes = await client.list();
  const labelsParent = mailboxes.find((mb) => mb.path === 'Labels' && mb.flags?.has('\\Noselect'));
  if (labelsParent) {
    return createProtonMailStrategy();
  }

  // 2. Check for Gmail: X-GM-EXT-1 capability
  if (client.capabilities?.has('X-GM-EXT-1')) {
    return createGmailStrategy();
  }

  // 3. Check PERMANENTFLAGS for \* (arbitrary keywords allowed)
  const lock = await client.getMailboxLock('INBOX');
  try {
    const mb = client.mailbox;
    if (mb && typeof mb === 'object' && 'permanentFlags' in mb) {
      const permFlags = mb.permanentFlags as Set<string>;
      if (permFlags.has('\\*')) {
        return createKeywordStrategy();
      }
    }
  } catch {
    // INBOX may not be accessible
  } finally {
    lock.release();
  }

  // 4. Fallback to keyword strategy (best effort)
  return createKeywordStrategy();
}
