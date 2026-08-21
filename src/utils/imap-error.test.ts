import { imapCommand } from './imap-error.js';

/** ImapFlow throws Error('Command failed') and puts the detail on `.response`. */
function rejection(response: string): Error & { response: string } {
  return Object.assign(new Error('Command failed'), { response });
}

describe('imapCommand', () => {
  it('passes a successful result through', async () => {
    await expect(imapCommand('Doing a thing', async () => 42)).resolves.toBe(42);
  });

  it('replaces the generic failure with what the server said', async () => {
    const run = imapCommand('Creating mailbox "X"', async () => {
      throw rejection('6 NO invalid mailbox name ["X"]: operation not allowed');
    });

    await expect(run).rejects.toThrow(
      'Creating mailbox "X" rejected by server: invalid mailbox name ["X"]: operation not allowed',
    );
  });

  it('strips the tag from a BAD response too', async () => {
    const run = imapCommand('Selecting', async () => {
      throw rejection('a7 BAD Missing required argument');
    });

    await expect(run).rejects.toThrow(/Selecting rejected by server: Missing required argument/);
  });

  it('keeps the original error as the cause', async () => {
    const original = rejection('9 NO over quota');
    try {
      await imapCommand('Appending', async () => {
        throw original;
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).cause).toBe(original);
    }
  });

  it('leaves an error with no server response untouched', async () => {
    // A socket reset carries no protocol detail; rewriting it would only
    // obscure the real cause.
    const run = imapCommand('Fetching', async () => {
      throw new Error('ECONNRESET');
    });

    await expect(run).rejects.toThrow('ECONNRESET');
  });

  it('falls back to the raw response when it does not match the tagged form', async () => {
    const run = imapCommand('Fetching', async () => {
      throw rejection('something unparseable');
    });

    await expect(run).rejects.toThrow(/something unparseable/);
  });
});
