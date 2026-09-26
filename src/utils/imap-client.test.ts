import { ImapFlow } from 'imapflow';
import { createImapClient, normalizeTlsServername } from './imap-client.js';

describe('normalizeTlsServername', () => {
  it('replaces the broken `false` fallback with undefined', () => {
    const client: { servername?: string | false | undefined } = { servername: false };
    normalizeTlsServername(client);
    expect(client.servername).toBeUndefined();
  });

  it('keeps an explicit servername', () => {
    const client: { servername?: string | false | undefined } = {
      servername: 'imap.example.org',
    };
    normalizeTlsServername(client);
    expect(client.servername).toBe('imap.example.org');
  });

  it('leaves an already-undefined servername alone', () => {
    const client: { servername?: string | false | undefined } = {};
    normalizeTlsServername(client);
    expect(client.servername).toBeUndefined();
  });
});

describe('createImapClient', () => {
  it('never leaves servername as `false`, even for IP hosts', () => {
    const client = createImapClient({
      host: '192.0.2.1',
      port: 993,
      secure: true,
      auth: { user: 'user', pass: 'pass' },
      logger: false,
    });
    expect(client).toBeInstanceOf(ImapFlow);
    const { servername } = client as unknown as { servername?: string | false | undefined };
    expect(servername).not.toBe(false);
  });
});
