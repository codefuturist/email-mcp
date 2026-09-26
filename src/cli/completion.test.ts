import type { AppConfig } from '../types/index.js';
import {
  completionCandidates,
  generateBashCompletion,
  generateFishCompletion,
  generateZshCompletion,
} from './completion.js';
import { SETTINGS_SECTIONS } from './settings-fields.js';

const config = {
  accounts: [{ name: 'personal' }, { name: 'work' }],
} as AppConfig;

describe('completionCandidates', () => {
  it('lists config-edit sections from the settings catalog (single source of truth)', () => {
    expect(completionCandidates('sections')).toEqual(SETTINGS_SECTIONS.map((s) => s.id));
  });

  it('lists account names from the loaded config', () => {
    expect(completionCandidates('accounts', config)).toEqual(['personal', 'work']);
  });

  it('returns nothing for unknown kinds or missing config', () => {
    expect(completionCandidates('accounts')).toEqual([]);
    expect(completionCandidates('nonsense' as never)).toEqual([]);
  });
});

describe('generated completion scripts', () => {
  const zsh = generateZshCompletion();
  const bash = generateBashCompletion();
  const fish = generateFishCompletion();

  it('zsh: compdef header, command descriptions, and dynamic hooks', () => {
    expect(zsh.startsWith('#compdef email-mcp')).toBe(true);
    for (const cmd of ['stdio', 'http', 'server', 'account', 'config', 'test', 'scheduler']) {
      expect(zsh).toContain(`'${cmd}:`);
    }
    expect(zsh).toContain('__complete accounts');
    expect(zsh).toContain('__complete sections');
    for (const sub of ['start', 'stop', 'status', 'restart', 'logs', 'install', 'uninstall']) {
      expect(zsh).toContain(`'${sub}:`);
    }
    expect(zsh).toContain('--port');
    expect(zsh).toContain('compdef _email-mcp email-mcp');
  });

  it('bash: complete registration and dynamic hooks', () => {
    expect(bash).toContain('complete -F _email_mcp email-mcp');
    expect(bash).toContain('__complete accounts');
    expect(bash).toContain('validate');
    expect(bash).toContain('--attach');
  });

  it('fish: per-command completions and dynamic hooks', () => {
    expect(fish).toContain("complete -c email-mcp -n '__fish_use_subcommand' -a stdio");
    expect(fish).toContain('__complete accounts');
    expect(fish).toContain('__complete sections');
    expect(fish).toContain('-l port');
  });

  it('every top-level command from the dispatcher is completable in all shells', () => {
    const commands = [
      'stdio',
      'http',
      'server',
      'account',
      'setup',
      'test',
      'install',
      'config',
      'scheduler',
      'notify',
      'update',
      'completion',
      'help',
    ];
    for (const cmd of commands) {
      expect(zsh).toContain(cmd);
      expect(bash).toContain(cmd);
      expect(fish).toContain(cmd);
    }
  });
});
