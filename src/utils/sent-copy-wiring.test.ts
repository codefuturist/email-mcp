import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const SMTP_SERVICE = join(SRC_DIR, 'services', 'smtp.service.ts');
const SCANNED = ['tools', 'services'];

// Callers that send but deliberately do not render the note yet. The scheduler
// runs unattended, so its outcome belongs in the stored record rather than in a
// string nobody reads — tracked separately. Wiring one of these up must turn
// this test GREEN by removing the entry, never leave a stale exemption behind.
const KNOWN_UNWIRED = ['scheduler.service.ts'];

/** Method names taken from SmtpService itself, so a fifth send path is covered the day it lands. */
async function sendMethodNames(): Promise<string[]> {
  const source = await readFile(SMTP_SERVICE, 'utf8');
  // Parameter lists wrap across lines here, so the return type has to be matched
  // through them rather than by slicing to the next brace.
  const declaration = /\n {2}(private )?async (\w+)\((?:[^()]|\([^()]*\))*\):\s*([^\n]*?)\s*\{/g;

  return [...source.matchAll(declaration)]
    .filter(([, isPrivate, , returnType]) => !isPrivate && returnType.includes('SendResult'))
    .map(([, , name]) => name);
}

async function callersMissingTheNote(methods: string[]): Promise<string[]> {
  const call = new RegExp(`\\.(${methods.join('|')})\\(`);

  const perDir = await Promise.all(
    SCANNED.map(async (dir) => {
      const files = (await readdir(join(SRC_DIR, dir))).filter(
        (file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && file !== 'smtp.service.ts',
      );

      const checked = await Promise.all(
        files.map(async (file) => {
          const source = await readFile(join(SRC_DIR, dir, file), 'utf8');
          return call.test(source) && !source.includes('sentCopyNote(') ? file : null;
        }),
      );

      return checked.filter((file): file is string => file !== null);
    }),
  );

  return perDir.flat();
}

// Two of the six send paths shipped without the note and nothing noticed: the
// copy was still filed, but a failure to file it stayed invisible to the caller.
describe('sent-copy wiring', () => {
  it('derives the send methods from SmtpService rather than a hardcoded list', async () => {
    expect(await sendMethodNames()).toEqual(
      expect.arrayContaining(['sendEmail', 'replyToEmail', 'forwardEmail', 'sendDraft']),
    );
  });

  it('every caller that sends also reports what happened to the Sent copy', async () => {
    const missing = await callersMissingTheNote(await sendMethodNames());

    expect(missing.filter((file) => !KNOWN_UNWIRED.includes(file))).toEqual([]);
  });

  it('lists no exemption that is already wired up', async () => {
    const missing = await callersMissingTheNote(await sendMethodNames());

    expect(KNOWN_UNWIRED.filter((file) => !missing.includes(file))).toEqual([]);
  });
});
