import { inject } from 'vitest';
import type { AccountConfig } from '../../types/index.js';

const TEST_ACCOUNT_NAME = 'integration';
const TEST_EMAIL = 'test@localhost';
const TEST_USER = 'test';

export function getGreenMailPorts() {
  const host = inject('greenmailHost');
  const smtpPort = inject('greenmailSmtpPort');
  const imapPort = inject('greenmailImapPort');
  return { host, smtpPort, imapPort };
}

export function buildTestAccount(overrides: Partial<AccountConfig> = {}): AccountConfig {
  const { host, smtpPort, imapPort } = getGreenMailPorts();
  return {
    name: TEST_ACCOUNT_NAME,
    email: TEST_EMAIL,
    fullName: 'Integration Test',
    username: TEST_USER,
    password: TEST_USER,
    imap: {
      host,
      port: imapPort,
      tls: false,
      starttls: false,
      verifySsl: false,
    },
    smtp: {
      host,
      port: smtpPort,
      tls: false,
      starttls: false,
      verifySsl: false,
    },
    ...overrides,
  };
}

export function buildSecondTestAccount(): AccountConfig {
  const { host, smtpPort, imapPort } = getGreenMailPorts();
  return {
    name: 'integration-2',
    email: 'bob@localhost',
    fullName: 'Bob Tester',
    username: 'bob',
    password: 'bob',
    imap: {
      host,
      port: imapPort,
      tls: false,
      starttls: false,
      verifySsl: false,
    },
    smtp: {
      host,
      port: smtpPort,
      tls: false,
      starttls: false,
      verifySsl: false,
    },
  };
}

export { TEST_ACCOUNT_NAME, TEST_EMAIL, TEST_USER };
