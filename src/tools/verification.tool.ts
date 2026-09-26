/**
 * MCP tools: get_verification_code, check_clipboard_setup
 *
 * The on-demand side of the verification feature: agents fetch (or wait
 * for) the newest OTP/magic link during signup/login flows, and users can
 * diagnose the clipboard integration. The ambient auto-copy loop lives in
 * VerificationCatcherService.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { loadRawConfig, saveConfigValidated } from '../config/loader.js';
import type { VerificationConfigSchema } from '../config/schema.js';
import type ClipboardService from '../services/clipboard.service.js';
import ClipboardServiceClass from '../services/clipboard.service.js';
import type ImapService from '../services/imap.service.js';
import type VerificationCatcherService from '../services/verification-catcher.service.js';
import { waitForVerification } from '../services/verification-catcher.service.js';
import type WatcherService from '../services/watcher.service.js';
import type { AppConfig, VerificationConfig } from '../types/index.js';
import { verificationOutputSchema } from './schemas.js';

/** camelCase runtime config → snake_case raw section (persist path). */
export function verificationToRaw(v: VerificationConfig): z.infer<typeof VerificationConfigSchema> {
  return {
    enabled: v.enabled,
    auto_copy: v.autoCopy,
    confirm_copy: v.confirmCopy,
    notify: v.notify,
    copy_links: v.copyLinks,
    link_action: v.linkAction,
    clear_after_seconds: v.clearAfterSeconds,
    max_age_minutes: v.maxAgeMinutes,
    accounts: v.accounts,
    sender_allowlist: v.senderAllowlist,
    sender_denylist: v.senderDenylist,
  };
}

function renderVerification(v: VerificationConfig): string[] {
  return [
    '[settings.verification]',
    `  enabled = ${v.enabled}`,
    `  auto_copy = ${v.autoCopy}`,
    `  confirm_copy = ${v.confirmCopy}`,
    `  notify = ${v.notify}`,
    `  copy_links = ${v.copyLinks}`,
    `  link_action = "${v.linkAction}"`,
    `  clear_after_seconds = ${v.clearAfterSeconds}`,
    `  max_age_minutes = ${v.maxAgeMinutes}`,
    `  accounts = ${v.accounts.length > 0 ? v.accounts.join(', ') : '(all)'}`,
    `  sender_allowlist = ${v.senderAllowlist.length > 0 ? v.senderAllowlist.join(', ') : '(all senders)'}`,
    `  sender_denylist = ${v.senderDenylist.length > 0 ? v.senderDenylist.join(', ') : '(none)'}`,
  ];
}

export default function registerVerificationTools(
  server: McpServer,
  imapService: ImapService,
  config: AppConfig,
  watcherService: WatcherService,
  clipboardService: ClipboardService,
  verificationCatcher: VerificationCatcherService,
): void {
  const verification = config.settings.verification;

  // ---------------------------------------------------------------------------
  // get_verification_code
  // ---------------------------------------------------------------------------

  server.registerTool(
    'get_verification_code',
    {
      title: 'Get verification code',
      description:
        'Find the newest verification code (OTP/2FA) or sign-in magic link in recent mail, ' +
        'using false-positive-resistant scoring (EN/DE). ' +
        'Use wait_seconds (max 45) to wait for a mail still in flight; if nothing arrives, ' +
        'simply call again. Works without the watcher via polling — with ' +
        '[settings.watcher] enabled, hits land within ~1 second. ' +
        'Set copy_to_clipboard=true to also place the value on the clipboard ' +
        '(concealed from clipboard managers, auto-cleared). ' +
        'The code/link is returned in the result by design.',
      inputSchema: z.object({
        account: z
          .string()
          .optional()
          .describe('Account name from list_accounts (omit to scan all accounts)'),
        mailbox: z.string().default('INBOX').describe('Mailbox to scan (default: INBOX)'),
        lookback_minutes: z
          .number()
          .int()
          .min(1)
          .max(240)
          .default(15)
          .describe('How far back to scan (default: 15)'),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(45)
          .default(0)
          .describe('Wait up to N seconds for a new mail before giving up (default: 0)'),
        copy_to_clipboard: z
          .boolean()
          .default(false)
          .describe("Also copy the found value to the user's clipboard"),
      }),
      outputSchema: verificationOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (params) => {
      try {
        const accounts = params.account ? [params.account] : config.accounts.map((a) => a.name);

        const hit = await waitForVerification(
          imapService,
          accounts,
          params.mailbox,
          params.lookback_minutes * 60_000,
          params.wait_seconds,
          { copyLinks: verification.copyLinks },
        );

        const watcherActive = watcherService.getStatus().length > 0;

        if (!hit) {
          const hints: string[] = [];
          if (!watcherActive) {
            hints.push(
              'The IMAP watcher is off — enable [settings.watcher] for instant ambient catching.',
            );
          }
          hints.push(
            'If the mail is still in flight, call again with wait_seconds=30.',
            'If the mail is older, raise lookback_minutes.',
          );
          return {
            content: [
              {
                type: 'text' as const,
                text: `📭 No verification code or sign-in link found in the last ${params.lookback_minutes} minutes.\n${hints.map((h) => `• ${h}`).join('\n')}`,
              },
            ],
            structuredContent: {
              found: false,
              copied: false,
              watcher_active: watcherActive,
              hint: hints.join(' '),
            },
          };
        }

        let copied = false;
        let concealed: boolean | undefined;
        if (params.copy_to_clipboard) {
          const write = await clipboardService.copyConcealed(hit.value, {
            clearAfterSeconds: verification.clearAfterSeconds,
          });
          copied = write.ok;
          concealed = write.ok ? write.concealed : undefined;
        }

        const ageSeconds = Math.max(0, Math.round((Date.now() - Date.parse(hit.date)) / 1000));
        const fromDisplay = hit.from.name
          ? `${hit.from.name} <${hit.from.address}>`
          : hit.from.address;
        const lines = [
          hit.kind === 'code'
            ? `🔐 Code from ${hit.service}: ${hit.value}`
            : `🔗 Sign-in link from ${hit.service}: ${hit.value}`,
          `From: ${fromDisplay}`,
          `Subject: ${hit.subject}`,
          `Age: ${ageSeconds}s${hit.confidence ? ` · Confidence: ${hit.confidence}` : ''}`,
        ];
        if (copied) {
          const clearNote =
            verification.clearAfterSeconds > 0
              ? ` (auto-clears in ${verification.clearAfterSeconds}s)`
              : '';
          lines.push(`📋 Copied to clipboard${clearNote}`);
        }

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          structuredContent: {
            found: true,
            kind: hit.kind,
            code: hit.kind === 'code' ? hit.value : undefined,
            link: hit.kind === 'link' ? hit.value : undefined,
            from: fromDisplay,
            subject: hit.subject,
            service: hit.service,
            account: hit.account,
            mailbox: hit.mailbox,
            age_seconds: ageSeconds,
            confidence: hit.confidence,
            copied,
            clipboard_concealed: concealed,
            watcher_active: watcherActive,
          },
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to scan for verification codes: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // check_clipboard_setup
  // ---------------------------------------------------------------------------

  server.registerTool(
    'check_clipboard_setup',
    {
      title: 'Check clipboard setup',
      description:
        'Diagnose the clipboard integration used for caught verification codes: platform ' +
        'tools, concealed-write support, current [settings.verification] values, and the ' +
        'watcher prerequisite. With test_write=true it performs a harmless clipboard ' +
        'round-trip (writes a test string, reads it back, clears it).',
      inputSchema: z.object({
        test_write: z
          .boolean()
          .default(false)
          .describe('Write/read/clear a test string to verify the pipeline end-to-end'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (params) => {
      try {
        const diag = await ClipboardServiceClass.checkPlatformSupport();
        const watcherActive = watcherService.getStatus().length > 0;

        const lines = [
          `📋 Clipboard setup — ${diag.platform}`,
          `Supported: ${diag.supported ? '✅' : '❌'}`,
          `Write tool: ${diag.writeTool.name} ${diag.writeTool.available ? '✅' : '❌'}`,
          `Read tool: ${diag.readTool.name} ${diag.readTool.available ? '✅' : '❌'}`,
          `Concealed writes (hidden from clipboard managers): ${diag.concealedSupported ? '✅' : '❌'}`,
        ];
        if (diag.issues.length > 0) lines.push('', 'Issues:', ...diag.issues.map((i) => `• ${i}`));
        if (diag.setupInstructions.length > 0) {
          lines.push('', 'Notes:', ...diag.setupInstructions.map((s) => `  ${s}`));
        }

        lines.push(
          '',
          '[settings.verification]',
          `  enabled = ${verification.enabled}`,
          `  auto_copy = ${verification.autoCopy}`,
          `  confirm_copy = ${verification.confirmCopy}`,
          `  notify = ${verification.notify}`,
          `  copy_links = ${verification.copyLinks}`,
          `  link_action = "${verification.linkAction}"`,
          `  clear_after_seconds = ${verification.clearAfterSeconds}`,
          `  max_age_minutes = ${verification.maxAgeMinutes}`,
        );
        if (
          process.platform !== 'darwin' &&
          (verification.confirmCopy || verification.linkAction === 'open')
        ) {
          lines.push(
            '',
            '⚠️ confirm_copy / link_action="open" need native dialogs, which are',
            'macOS-only for now — on this platform those hits degrade to',
            'notification-only.',
          );
        }

        if (verification.enabled && !watcherActive) {
          lines.push(
            '',
            '⚠️ Verification is enabled but the IMAP watcher is not running — ambient',
            'auto-copy is inactive. Enable it with:',
            '  [settings.watcher]',
            '  enabled = true',
            '(get_verification_code still works on demand.)',
          );
        }

        if (params.test_write) {
          const write = await clipboardService.copyConcealed('email-mcp-clipboard-test', {
            clearAfterSeconds: 0,
          });
          if (write.ok) {
            const readBack = await clipboardService.read();
            const roundTrip = readBack === 'email-mcp-clipboard-test';
            if (roundTrip) await clipboardService.clear();
            lines.push(
              '',
              `Test write: ✅ (concealed: ${write.concealed ? 'yes' : 'no — plain fallback'})`,
              `Read-back: ${roundTrip ? '✅ verified and cleared' : `⚠️ clipboard held something else${readBack === undefined ? ' (read failed)' : ''}`}`,
            );
          } else {
            lines.push('', `Test write: ❌ ${write.error ?? 'unknown error'}`);
          }
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Clipboard diagnostics failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // configure_verification
  // ---------------------------------------------------------------------------

  server.registerTool(
    'configure_verification',
    {
      title: 'Configure verification catching',
      description:
        'Update [settings.verification] at runtime — changes take effect immediately, ' +
        'including starting/stopping the ambient catcher via `enabled`. ' +
        'Use save=true to persist to config.toml (previous file is backed up). ' +
        'Omit every field to see the current configuration. ' +
        'Registered in read-only mode too: this writes config, never the mailbox.',
      inputSchema: z.object({
        enabled: z.boolean().optional().describe('Master switch for verification catching'),
        auto_copy: z.boolean().optional().describe('Copy caught codes/links to the clipboard'),
        confirm_copy: z
          .boolean()
          .optional()
          .describe('Ask (native dialog) before touching the clipboard'),
        notify: z.boolean().optional().describe('Desktop notification when something is caught'),
        copy_links: z.boolean().optional().describe('Also catch sign-in magic links'),
        link_action: z
          .enum(['open', 'copy'])
          .optional()
          .describe('Caught links: offer to open in the browser, or copy like a code'),
        clear_after_seconds: z
          .number()
          .int()
          .min(0)
          .max(3600)
          .optional()
          .describe('Auto-clear clipboard after N seconds (0 = never)'),
        max_age_minutes: z
          .number()
          .int()
          .min(1)
          .max(1440)
          .optional()
          .describe('Ignore messages older than this'),
        accounts: z.array(z.string()).optional().describe('Accounts to watch (empty array = all)'),
        sender_allowlist: z
          .array(z.string())
          .optional()
          .describe('Sender globs, e.g. ["*@github.com"] (empty = all senders)'),
        sender_denylist: z.array(z.string()).optional().describe('Sender globs to ignore'),
        save: z
          .boolean()
          .default(false)
          .describe('Persist changes to config.toml (default: runtime only)'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (params) => {
      try {
        const partial: Partial<VerificationConfig> = {};
        if (params.enabled !== undefined) partial.enabled = params.enabled;
        if (params.auto_copy !== undefined) partial.autoCopy = params.auto_copy;
        if (params.confirm_copy !== undefined) partial.confirmCopy = params.confirm_copy;
        if (params.notify !== undefined) partial.notify = params.notify;
        if (params.copy_links !== undefined) partial.copyLinks = params.copy_links;
        if (params.link_action !== undefined) partial.linkAction = params.link_action;
        if (params.clear_after_seconds !== undefined) {
          partial.clearAfterSeconds = params.clear_after_seconds;
        }
        if (params.max_age_minutes !== undefined) partial.maxAgeMinutes = params.max_age_minutes;
        if (params.accounts !== undefined) partial.accounts = params.accounts;
        if (params.sender_allowlist !== undefined) {
          partial.senderAllowlist = params.sender_allowlist;
        }
        if (params.sender_denylist !== undefined) partial.senderDenylist = params.sender_denylist;

        if (Object.keys(partial).length === 0) {
          const watcherActive = watcherService.getStatus().length > 0;
          return {
            content: [
              {
                type: 'text' as const,
                text: [
                  'No changes specified. Current config:',
                  ...renderVerification(verification),
                  '',
                  `Watcher: ${watcherActive ? '✅ active' : '❌ not running (ambient catching inactive)'}`,
                ].join('\n'),
              },
            ],
          };
        }

        const prevEnabled = verification.enabled;
        // Mutate in place — `verification` is the same object instance the
        // catcher holds (identity contract); reassigning would silently
        // detach runtime behavior from this tool.
        Object.assign(verification, partial);

        const lines = [
          '✅ Verification configuration updated:',
          ...renderVerification(verification),
        ];

        if (partial.enabled !== undefined && partial.enabled !== prevEnabled) {
          if (partial.enabled) {
            verificationCatcher.start();
            lines.push('', '▶️ Ambient catcher started.');
            if (watcherService.getStatus().length === 0) {
              lines.push(
                '⚠️ The IMAP watcher is not running — ambient auto-copy stays inactive until',
                '   [settings.watcher] enabled = true and the server restarts.',
                '   (get_verification_code works either way.)',
              );
            }
          } else {
            verificationCatcher.stop();
            lines.push('', '⏸️ Ambient catcher stopped.');
          }
        }

        if (params.save) {
          try {
            const rawConfig = await loadRawConfig();
            rawConfig.settings.verification = verificationToRaw(verification);
            const saved = await saveConfigValidated(rawConfig);
            lines.push(
              '',
              `💾 Changes saved to config file.${saved.backupPath ? ` (backup: ${saved.backupPath})` : ''}`,
            );
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            lines.push(
              '',
              `⚠️ Could not save to config file: ${errMsg}`,
              '   Changes are active for this session only.',
            );
          }
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to update verification config: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );
}
