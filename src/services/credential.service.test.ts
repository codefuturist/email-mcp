import { resolveCredential } from './credential.service.js';

describe('resolveCredential', () => {
  describe('plaintext source', () => {
    it('resolves plaintext when password is provided and no source', async () => {
      const result = await resolveCredential('test', undefined, 'my-password');
      expect(result).toEqual({ password: 'my-password', source: 'plaintext' });
    });

    it('resolves plaintext when credential_source is "plaintext"', async () => {
      const result = await resolveCredential('test', 'plaintext', 'my-password');
      expect(result).toEqual({ password: 'my-password', source: 'plaintext' });
    });

    it('throws when plaintext source but no password', async () => {
      await expect(resolveCredential('test', 'plaintext', undefined)).rejects.toThrow(
        'No password configured',
      );
    });
  });

  describe('env source', () => {
    it('resolves from environment variable', async () => {
      process.env.TEST_EMAIL_PW = 'env-password';
      const result = await resolveCredential('test', 'env:TEST_EMAIL_PW', undefined);
      expect(result).toEqual({ password: 'env-password', source: 'env' });
      delete process.env.TEST_EMAIL_PW;
    });

    it('throws when env var is not set', async () => {
      delete process.env.NONEXISTENT_VAR;
      await expect(resolveCredential('test', 'env:NONEXISTENT_VAR', undefined)).rejects.toThrow(
        'is not set',
      );
    });
  });

  describe('command source', () => {
    it('resolves from command stdout, trimming trailing newline', async () => {
      const result = await resolveCredential('test', 'command:printf "cmd-password\\n"', undefined);
      expect(result).toEqual({ password: 'cmd-password', source: 'command' });
    });

    it('supports pipes and quoting (runs in a shell)', async () => {
      const result = await resolveCredential('test', "command:echo 'a b c' | tr -d ' '", undefined);
      expect(result).toEqual({ password: 'abc', source: 'command' });
    });

    it('throws when the command produces no output', async () => {
      await expect(resolveCredential('test', 'command:true', undefined)).rejects.toThrow(
        /Credential command failed/,
      );
    });

    it('throws when the command is empty', async () => {
      await expect(resolveCredential('test', 'command:   ', undefined)).rejects.toThrow(
        /Empty command/,
      );
    });

    it('throws when the command exits non-zero', async () => {
      await expect(resolveCredential('test', 'command:exit 3', undefined)).rejects.toThrow(
        /Credential command failed/,
      );
    });
  });

  describe('unknown source', () => {
    it('throws for unknown credential_source value', async () => {
      await expect(resolveCredential('test', 'something-else', undefined)).rejects.toThrow(
        'Unknown credential_source',
      );
    });
  });

  describe('keychain source', () => {
    it('falls back to keychain when no password and no source specified', async () => {
      // This will fail because there's no keychain entry, but it should attempt keychain
      await expect(resolveCredential('nonexistent-acct', undefined, undefined)).rejects.toThrow(
        /keychain|secret/i,
      );
    });
  });
});
