import type { StartedTestContainer } from 'testcontainers';
import { GenericContainer, Wait } from 'testcontainers';
import type { GlobalSetupContext } from 'vitest/node';

const GREENMAIL_IMAGE = 'greenmail/standalone:2.1.8';
const SMTP_PORT = 3025;
const IMAP_PORT = 3143;

let container: StartedTestContainer;

export async function setup({ provide }: GlobalSetupContext) {
  console.log('🚀 Starting GreenMail container...');

  container = await new GenericContainer(GREENMAIL_IMAGE)
    .withExposedPorts(SMTP_PORT, IMAP_PORT)
    .withEnvironment({
      GREENMAIL_OPTS: [
        '-Dgreenmail.setup.test.all',
        '-Dgreenmail.hostname=0.0.0.0',
        '-Dgreenmail.users=test:test@localhost,bob:bob@localhost,alice:alice@localhost,sender:sender@localhost',
      ].join(' '),
    })
    .withWaitStrategy(Wait.forListeningPorts())
    .withStartupTimeout(60_000)
    .start();

  const smtpPort = container.getMappedPort(SMTP_PORT);
  const imapPort = container.getMappedPort(IMAP_PORT);
  const host = container.getHost();

  provide('greenmailHost', host);
  provide('greenmailSmtpPort', smtpPort);
  provide('greenmailImapPort', imapPort);

  console.log(`✅ GreenMail ready — SMTP :${smtpPort}, IMAP :${imapPort}`);
}

export async function teardown() {
  if (container) {
    console.log('🛑 Stopping GreenMail container...');
    await container.stop();
    console.log('✅ GreenMail stopped');
  }
}
