import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const SEND_CALL = /smtpService\.(sendEmail|replyToEmail|forwardEmail|sendDraft)\(/;

// Two of the six send paths shipped without the note and nothing noticed: the
// copy was still filed, but a failure to file it stayed invisible to the caller.
describe('sent-copy wiring', () => {
  it('every tool that sends also reports what happened to the Sent copy', async () => {
    const files = (await readdir(TOOLS_DIR)).filter((file) => file.endsWith('.tool.ts'));
    const sources = await Promise.all(
      files.map(async (file) => [file, await readFile(join(TOOLS_DIR, file), 'utf8')] as const),
    );

    const unwired = sources
      .filter(([, source]) => SEND_CALL.test(source) && !source.includes('sentCopyNote('))
      .map(([file]) => file);

    expect(unwired).toEqual([]);
  });
});
