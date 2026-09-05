import { credentialFields } from './account-commands.js';

describe('credentialFields', () => {
  it('writes password_command and clears password when a command was given', () => {
    const fields = credentialFields({
      username: 'u',
      password: '',
      passwordCommand: 'printf secret',
    });

    expect(fields.password_command).toBe('printf secret');
    expect(fields.password).toBeUndefined();
  });

  it('writes password and clears password_command when a password was typed', () => {
    const fields = credentialFields({ username: 'u', password: 'typed' });

    expect(fields.password).toBe('typed');
    expect(fields.password_command).toBeUndefined();
  });

  // The regression that matters: an `account edit` touching only the display
  // name must leave the account's credential source alone. Returning any key
  // here would clobber whatever buildRawAccount spread in from the existing
  // account — password_command and oauth2 included.
  it('returns no keys when neither credential was collected', () => {
    expect(credentialFields({ username: 'u', password: '' })).toEqual({});
  });

  it('prefers the command when both are somehow present', () => {
    const fields = credentialFields({
      username: 'u',
      password: 'stale',
      passwordCommand: 'printf fresh',
    });

    expect(fields.password_command).toBe('printf fresh');
    expect(fields.password).toBeUndefined();
  });
});
