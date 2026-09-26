/**
 * Shell completion (zsh, bash, fish) — kubectl-style:
 *
 *   source <(email-mcp completion zsh)     # one line in ~/.zshrc
 *   source <(email-mcp completion bash)    # one line in ~/.bashrc
 *   email-mcp completion fish | source     # or write to ~/.config/fish/completions/
 *
 * Scripts are generated from the COMMAND tree below, and the dynamic values
 * (account names, config-edit sections) are resolved at completion time via
 * the hidden `email-mcp __complete <kind>` helper — so completions follow
 * the user's actual config and never drift from the settings catalog.
 */

import type { AppConfig } from '../types/index.js';
import { SETTINGS_SECTIONS } from './settings-fields.js';

export type DynamicKind = 'accounts' | 'sections';

interface FlagSpec {
  flag: string;
  description: string;
  takesValue?: boolean;
}

interface SubcommandSpec {
  name: string;
  description: string;
  /** Dynamic completion for the positional argument after this subcommand. */
  arg?: DynamicKind;
  flags?: FlagSpec[];
}

interface CommandSpec {
  name: string;
  description: string;
  subcommands?: SubcommandSpec[];
  arg?: DynamicKind;
  flags?: FlagSpec[];
}

const HTTP_FLAGS: FlagSpec[] = [
  { flag: '--host', description: 'Bind address', takesValue: true },
  { flag: '--port', description: 'Port', takesValue: true },
  { flag: '--path', description: 'HTTP path for the MCP endpoint', takesValue: true },
  { flag: '--token', description: 'Bearer token', takesValue: true },
  { flag: '--allowed-hosts', description: 'Host-header allowlist', takesValue: true },
  { flag: '--insecure', description: 'Allow non-loopback bind without a token' },
];

const SERVER_START_FLAGS: FlagSpec[] = [
  { flag: '--attach', description: 'Run in the foreground instead of detaching' },
  ...HTTP_FLAGS,
];

export const COMMANDS: CommandSpec[] = [
  { name: 'stdio', description: 'Run as MCP server over stdio (default)' },
  {
    name: 'http',
    description: 'Run as MCP server over Streamable HTTP',
    flags: HTTP_FLAGS,
  },
  {
    name: 'server',
    description: 'Always-on HTTP server lifecycle',
    subcommands: [
      { name: 'start', description: 'Start detached (or --attach)', flags: SERVER_START_FLAGS },
      {
        name: 'stop',
        description: 'Stop the detached server',
        flags: [{ flag: '--force', description: 'SIGKILL after SIGTERM times out' }],
      },
      { name: 'status', description: 'Show pid, address, health, uptime' },
      { name: 'restart', description: 'Stop and start again', flags: SERVER_START_FLAGS },
      {
        name: 'logs',
        description: 'Show the last daemon log lines',
        flags: [{ flag: '--lines', description: 'Number of lines', takesValue: true }],
      },
      { name: 'install', description: 'Install as macOS login item', flags: HTTP_FLAGS },
      { name: 'uninstall', description: 'Remove the login item' },
    ],
  },
  {
    name: 'account',
    description: 'Account management',
    subcommands: [
      { name: 'list', description: 'List configured accounts' },
      { name: 'add', description: 'Add an account interactively' },
      { name: 'edit', description: 'Edit an account', arg: 'accounts' },
      { name: 'delete', description: 'Remove an account', arg: 'accounts' },
    ],
  },
  { name: 'setup', description: "Alias for 'account add'" },
  { name: 'test', description: 'Test IMAP/SMTP connections', arg: 'accounts' },
  {
    name: 'install',
    description: 'Register with MCP clients',
    subcommands: [
      { name: 'status', description: 'Show client registration status' },
      { name: 'remove', description: 'Unregister from MCP clients' },
    ],
  },
  {
    name: 'config',
    description: 'Config management',
    subcommands: [
      { name: 'show', description: 'Show current configuration' },
      { name: 'edit', description: 'Interactive settings editor', arg: 'sections' },
      { name: 'validate', description: 'Check syntax, schema, typos, consistency' },
      { name: 'path', description: 'Print config file path' },
      { name: 'init', description: 'Create a template config file' },
    ],
  },
  {
    name: 'scheduler',
    description: 'Email scheduling management',
    subcommands: [
      { name: 'check', description: 'Send overdue scheduled emails' },
      { name: 'list', description: 'List the schedule queue' },
      { name: 'install', description: 'Install the OS periodic check' },
      { name: 'uninstall', description: 'Remove the OS periodic check' },
      { name: 'status', description: 'Show scheduler status' },
    ],
  },
  {
    name: 'notify',
    description: 'Desktop notification diagnostics',
    subcommands: [
      { name: 'test', description: 'Send a test notification' },
      { name: 'status', description: 'Check platform notification support' },
    ],
  },
  {
    name: 'completion',
    description: 'Print shell completion script',
    subcommands: [
      { name: 'zsh', description: 'Zsh completion script' },
      { name: 'bash', description: 'Bash completion script' },
      { name: 'fish', description: 'Fish completion script' },
    ],
  },
  { name: 'help', description: 'Show help' },
];

/** Dynamic candidates for the hidden `__complete <kind>` helper. */
export function completionCandidates(kind: DynamicKind, config?: AppConfig): string[] {
  if (kind === 'sections') return SETTINGS_SECTIONS.map((s) => s.id);
  if (kind === 'accounts') return config?.accounts.map((a) => a.name) ?? [];
  return [];
}

const zq = (text: string): string => text.replace(/'/g, "''").replace(/[[\]]/g, '');

// ---------------------------------------------------------------------------
// zsh
// ---------------------------------------------------------------------------

export function generateZshCompletion(): string {
  const commandList = COMMANDS.map((c) => `    '${c.name}:${zq(c.description)}'`).join('\n');

  const caseArms = COMMANDS.filter((c) => c.subcommands || c.arg || c.flags)
    .map((c) => {
      const parts: string[] = [`    ${c.name})`];
      if (c.subcommands) {
        const subs = c.subcommands
          .map((s) => `          '${s.name}:${zq(s.description)}'`)
          .join('\n');
        parts.push(
          '      if (( CURRENT == 2 )); then',
          '        local -a subcommands',
          '        subcommands=(',
          subs,
          '        )',
          `        _describe -t subcommands '${c.name} subcommand' subcommands`,
        );
        const dynamicSubs = c.subcommands.filter((s) => s.arg);
        if (dynamicSubs.length > 0) {
          const names = dynamicSubs.map((s) => s.name).join('|');
          const kind = dynamicSubs[0]?.arg;
          parts.push(
            `      elif (( CURRENT == 3 )) && [[ \${words[2]} == (${names}) ]]; then`,
            `        local -a values; values=(\${(f)"$(email-mcp __complete ${kind} 2>/dev/null)"})`,
            `        _describe -t values '${kind}' values`,
          );
        }
        const flagged = c.subcommands.filter((s) => s.flags?.length);
        if (flagged.length > 0) {
          // biome-ignore lint/suspicious/noTemplateCurlyInString: emits literal zsh syntax
          parts.push('      else', '        case ${words[2]} in');
          for (const s of flagged) {
            const flagArgs = (s.flags ?? [])
              .map(
                (f) =>
                  `'${f.flag}[${zq(f.description)}]${f.takesValue ? `:${f.flag.replace(/^--?/, '')}:` : ''}'`,
              )
              .join(' \\\n              ');
            parts.push(
              `          ${s.name})`,
              `            _arguments ${flagArgs}`,
              '            ;;',
            );
          }
          parts.push('        esac');
        }
        parts.push('      fi');
      } else if (c.arg) {
        parts.push(
          '      if (( CURRENT == 2 )); then',
          `        local -a values; values=(\${(f)"$(email-mcp __complete ${c.arg} 2>/dev/null)"})`,
          `        _describe -t values '${c.arg}' values`,
          '      fi',
        );
      } else if (c.flags) {
        const flagArgs = c.flags
          .map(
            (f) =>
              `'${f.flag}[${zq(f.description)}]${f.takesValue ? `:${f.flag.replace(/^--?/, '')}:` : ''}'`,
          )
          .join(' \\\n          ');
        parts.push(`        _arguments ${flagArgs}`);
      }
      parts.push('      ;;');
      return parts.join('\n');
    })
    .join('\n');

  return `#compdef email-mcp
# email-mcp shell completion (zsh).
# Install:  echo 'source <(email-mcp completion zsh)' >> ~/.zshrc
# Or via fpath:  email-mcp completion zsh > "\${fpath[1]}/_email-mcp"

_email-mcp() {
  local curcontext="$curcontext" state line
  typeset -A opt_args

  _arguments -C \\
    '1:command:->command' \\
    '*::arg:->args'

  case $state in
  command)
    local -a commands
    commands=(
${commandList}
    )
    _describe -t commands 'email-mcp command' commands
    ;;
  args)
    case \${words[1]} in
${caseArms}
    esac
    ;;
  esac
}

if [ "\${funcstack[1]}" = "_email-mcp" ]; then
  _email-mcp "$@"
else
  compdef _email-mcp email-mcp
fi
`;
}

// ---------------------------------------------------------------------------
// bash
// ---------------------------------------------------------------------------

export function generateBashCompletion(): string {
  const topLevel = COMMANDS.map((c) => c.name).join(' ');

  const arms = COMMANDS.filter((c) => c.subcommands || c.arg || c.flags)
    .map((c) => {
      const lines: string[] = [`    ${c.name})`];
      if (c.subcommands) {
        const subs = c.subcommands.map((s) => s.name).join(' ');
        const dynamic = c.subcommands.filter((s) => s.arg);
        const flagged = c.subcommands.filter((s) => s.flags?.length);
        lines.push('      if [ "$COMP_CWORD" -eq 2 ]; then', `        words="${subs}"`);
        if (dynamic.length > 0) {
          const names = dynamic.map((s) => s.name).join('|');
          lines.push(
            '      elif [ "$COMP_CWORD" -eq 3 ]; then',
            '        case "$sub" in',
            `          ${names}) words="$(email-mcp __complete ${dynamic[0]?.arg} 2>/dev/null)" ;;`,
          );
          for (const s of flagged.filter((f) => !f.arg)) {
            lines.push(
              `          ${s.name}) words="${(s.flags ?? []).map((f) => f.flag).join(' ')}" ;;`,
            );
          }
          lines.push('        esac');
        }
        if (flagged.length > 0) {
          lines.push('      else', '        case "$sub" in');
          for (const s of flagged) {
            lines.push(
              `          ${s.name}) words="${(s.flags ?? []).map((f) => f.flag).join(' ')}" ;;`,
            );
          }
          lines.push('        esac', '      fi');
        } else {
          lines.push('      fi');
        }
      } else if (c.arg) {
        lines.push(
          '      if [ "$COMP_CWORD" -eq 2 ]; then',
          `        words="$(email-mcp __complete ${c.arg} 2>/dev/null)"`,
          '      fi',
        );
      } else if (c.flags) {
        lines.push(`      words="${c.flags.map((f) => f.flag).join(' ')}"`);
      }
      lines.push('      ;;');
      return lines.join('\n');
    })
    .join('\n');

  return `# email-mcp shell completion (bash).
# Install:  echo 'source <(email-mcp completion bash)' >> ~/.bashrc

_email_mcp() {
  local cur cmd sub words
  cur="\${COMP_WORDS[COMP_CWORD]}"
  cmd="\${COMP_WORDS[1]}"
  sub="\${COMP_WORDS[2]}"
  words=""

  if [ "$COMP_CWORD" -eq 1 ]; then
    words="${topLevel}"
  else
    case "$cmd" in
${arms}
    esac
  fi

  COMPREPLY=( $(compgen -W "$words" -- "$cur") )
}
complete -F _email_mcp email-mcp
`;
}

// ---------------------------------------------------------------------------
// fish
// ---------------------------------------------------------------------------

export function generateFishCompletion(): string {
  const lines: string[] = [
    '# email-mcp shell completion (fish).',
    '# Install:  email-mcp completion fish > ~/.config/fish/completions/email-mcp.fish',
    '',
    'complete -c email-mcp -f',
  ];
  const fq = (text: string): string => text.replace(/'/g, "\\'");

  for (const c of COMMANDS) {
    lines.push(
      `complete -c email-mcp -n '__fish_use_subcommand' -a ${c.name} -d '${fq(c.description)}'`,
    );
    const guard = `__fish_seen_subcommand_from ${c.name}`;
    if (c.subcommands) {
      for (const s of c.subcommands) {
        lines.push(
          `complete -c email-mcp -n '${guard}; and not __fish_seen_subcommand_from ${c.subcommands
            .map((x) => x.name)
            .join(' ')}' -a ${s.name} -d '${fq(s.description)}'`,
        );
        if (s.arg) {
          lines.push(
            `complete -c email-mcp -n '${guard}; and __fish_seen_subcommand_from ${s.name}' -a '(email-mcp __complete ${s.arg} 2>/dev/null)'`,
          );
        }
        for (const f of s.flags ?? []) {
          const long = f.flag.replace(/^--/, '');
          if (!f.flag.startsWith('--')) continue;
          lines.push(
            `complete -c email-mcp -n '${guard}; and __fish_seen_subcommand_from ${s.name}' -l ${long} -d '${fq(f.description)}'${f.takesValue ? ' -x' : ''}`,
          );
        }
      }
    }
    if (c.arg) {
      lines.push(
        `complete -c email-mcp -n '${guard}' -a '(email-mcp __complete ${c.arg} 2>/dev/null)'`,
      );
    }
    for (const f of c.flags ?? []) {
      const long = f.flag.replace(/^--/, '');
      if (!f.flag.startsWith('--')) continue;
      lines.push(
        `complete -c email-mcp -n '${guard}' -l ${long} -d '${fq(f.description)}'${f.takesValue ? ' -x' : ''}`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

function detectShell(): 'zsh' | 'bash' | 'fish' | undefined {
  const shell = process.env.SHELL ?? '';
  if (shell.endsWith('zsh')) return 'zsh';
  if (shell.endsWith('bash')) return 'bash';
  if (shell.endsWith('fish')) return 'fish';
  return undefined;
}

export default function runCompletionCommand(shellArg?: string): void {
  const shell = shellArg ?? detectShell();
  switch (shell) {
    case 'zsh':
      process.stdout.write(generateZshCompletion());
      return;
    case 'bash':
      process.stdout.write(generateBashCompletion());
      return;
    case 'fish':
      process.stdout.write(generateFishCompletion());
      return;
    default:
      console.log(`Usage: email-mcp completion <zsh|bash|fish>

Prints a completion script for your shell. Install:

  zsh:   echo 'source <(email-mcp completion zsh)' >> ~/.zshrc
  bash:  echo 'source <(email-mcp completion bash)' >> ~/.bashrc
  fish:  email-mcp completion fish > ~/.config/fish/completions/email-mcp.fish

Completions include account names from your config and config-edit sections.`);
      if (shellArg) process.exitCode = 1;
  }
}
