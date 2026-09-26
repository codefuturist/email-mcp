/**
 * Constructing ImapFlow clients with upstream's TLS SNI fallback repaired.
 */

import { ImapFlow } from 'imapflow';

type ImapClientOptions = ConstructorParameters<typeof ImapFlow>[0];

/**
 * imapflow's constructor falls back to `servername = false` when the host is
 * an IP literal, and node's tls.connect() rejects a non-string servername.
 * Local installs get the fixed line via patches/imapflow.patch, but pnpm
 * patches never reach npm consumers of this package — so the same repair is
 * applied at runtime. Drop once the fix ships in an imapflow release.
 */
export function normalizeTlsServername(client: { servername?: string | false | undefined }): void {
  if (client.servername === false) {
    client.servername = undefined;
  }
}

/** Build an ImapFlow client; use this instead of calling `new ImapFlow` directly. */
export function createImapClient(options: ImapClientOptions): ImapFlow {
  const client = new ImapFlow(options);
  normalizeTlsServername(client as unknown as { servername?: string | false | undefined });
  return client;
}
