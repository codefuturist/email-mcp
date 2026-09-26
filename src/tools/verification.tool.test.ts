import { VerificationConfigSchema } from '../config/schema.js';
import type { VerificationConfig } from '../types/index.js';
import { verificationToRaw } from './verification.tool.js';

describe('verificationToRaw', () => {
  it('maps every schema key exactly (drift guard for the persist path)', () => {
    const camel: VerificationConfig = {
      enabled: false,
      autoCopy: false,
      confirmCopy: true,
      notify: false,
      copyLinks: false,
      linkAction: 'copy',
      clearAfterSeconds: 30,
      maxAgeMinutes: 5,
      accounts: ['work'],
      senderAllowlist: ['*@github.com'],
      senderDenylist: ['*@spam.example'],
    };

    const raw = verificationToRaw(camel);

    expect(Object.keys(raw).sort()).toEqual(Object.keys(VerificationConfigSchema.shape).sort());
    expect(VerificationConfigSchema.parse(raw)).toEqual(raw);
    expect(raw.confirm_copy).toBe(true);
    expect(raw.link_action).toBe('copy');
    expect(raw.sender_allowlist).toEqual(['*@github.com']);
  });
});
