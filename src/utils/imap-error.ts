/**
 * Turning IMAP protocol failures into messages a caller can act on.
 */

/**
 * Run an IMAP command, replacing ImapFlow's generic failure with what the
 * server actually said.
 *
 * On a tagged NO/BAD response ImapFlow throws `Error('Command failed')` and
 * puts the raw server line on `.response`. So a refusal the server explained
 * precisely — `NO invalid mailbox name ["X"]: operation not allowed` — reaches
 * the user as "Command failed", which says nothing about what to do next.
 *
 * Errors carrying no server response, such as a socket reset, are passed
 * through untouched: rewriting those would obscure the real cause.
 *
 * @param operation what was being attempted, phrased for a human
 * @param run the ImapFlow call
 */
export async function imapCommand<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const response = (err as { response?: unknown }).response;
    if (typeof response !== 'string' || response.length === 0) throw err;

    // Strip the leading command tag ("6 NO ", "a7 BAD ") so it reads as prose.
    const detail = response.replace(/^\S+\s+(NO|BAD)\s+/i, '').trim();
    throw new Error(`${operation} rejected by server: ${detail || response}`, { cause: err });
  }
}
