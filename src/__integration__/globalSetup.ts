import type { StartedTestContainer } from 'testcontainers';
import { GenericContainer, Wait } from 'testcontainers';
import type { GlobalSetupContext } from 'vitest/node';

const GREENMAIL_IMAGE = 'greenmail/standalone:2.1.8';
const SMTP_PORT = 3025;
const SMTPS_PORT = 3465;
const IMAP_PORT = 3143;
const IMAPS_PORT = 3993;

let container: StartedTestContainer;

export async function setup({ provide }: GlobalSetupContext) {
  console.log('🚀 Starting GreenMail container...');

  container = await new GenericContainer(GREENMAIL_IMAGE)
    .withExposedPorts(SMTP_PORT, SMTPS_PORT, IMAP_PORT, IMAPS_PORT)
    .withEnvironment({
      GREENMAIL_OPTS: [
        '-Dgreenmail.setup.test.all',
        '-Dgreenmail.hostname=0.0.0.0',
        '-Dgreenmail.users=test:test@localhost,bob:bob@localhost,alice:alice@localhost,sender:sender@localhost,authsender:authsender@localhost',
      ].join(' '),
    })
    .withWaitStrategy(Wait.forListeningPorts())
    .withStartupTimeout(60_000)
    .start();

  const host = container.getHost();
  const smtpPort = container.getMappedPort(SMTP_PORT);
  const smtpsPort = container.getMappedPort(SMTPS_PORT);
  const imapPort = container.getMappedPort(IMAP_PORT);
  const imapsPort = container.getMappedPort(IMAPS_PORT);

  provide('greenmailHost', host);
  provide('greenmailSmtpPort', smtpPort);
  provide('greenmailSmtpsPort', smtpsPort);
  provide('greenmailImapPort', imapPort);
  provide('greenmailImapsPort', imapsPort);

  console.log(
    `✅ GreenMail ready — SMTP :${smtpPort}, SMTPS :${smtpsPort}, IMAP :${imapPort}, IMAPS :${imapsPort}`,
  );
}

export async function teardown() {
  if (container) {
    console.log('🛑 Stopping GreenMail container...');
    await container.stop();
    console.log('✅ GreenMail stopped');
  }
}
