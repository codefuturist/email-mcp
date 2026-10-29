import { CredentialAlertsConfigSchema } from '../config/schema.js';
import type { CredentialAlertsConfig } from '../types/index.js';
import { credentialAlertsFromRaw, credentialAlertsToRaw } from './watcher.tool.js';

describe('credentialAlertsToRaw', () => {
  it('maps every schema key exactly (drift guard for the persist path)', () => {
    const camel: CredentialAlertsConfig = {
      enabled: false,
      sound: false,
      remindEveryMinutes: 120,
      webhook: true,
    };
    const raw = credentialAlertsToRaw(camel);
    expect(Object.keys(raw).sort()).toEqual(Object.keys(CredentialAlertsConfigSchema.shape).sort());
    expect(CredentialAlertsConfigSchema.parse(raw)).toEqual(raw);
    expect(raw.remind_every_minutes).toBe(120);
  });
});

describe('credentialAlertsFromRaw', () => {
  it('turns a partial snake_case tool input into a camelCase patch, dropping unset keys', () => {
    expect(credentialAlertsFromRaw({ remind_every_minutes: 30 })).toEqual({
      remindEveryMinutes: 30,
    });
    expect(credentialAlertsFromRaw({ enabled: false, webhook: true })).toEqual({
      enabled: false,
      webhook: true,
    });
    expect(credentialAlertsFromRaw({})).toEqual({});
  });
});
