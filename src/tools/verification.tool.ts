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

import type ClipboardService from '../services/clipboard.service.js';
import ClipboardServiceClass from '../services/clipboard.service.js';
import type ImapService from '../services/imap.service.js';
import { waitForVerification } from '../services/verification-catcher.service.js';
import type WatcherService from '../services/watcher.service.js';
import type { AppConfig } from '../types/index.js';
import { verificationOutputSchema } from './schemas.js';

export default function registerVerificationTools(
  server: McpServer,
  imapService: ImapService,
  config: AppConfig,
  watcherService: WatcherService,
  clipboardService: ClipboardService,
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
          `  notify = ${verification.notify}`,
          `  copy_links = ${verification.copyLinks}`,
          `  clear_after_seconds = ${verification.clearAfterSeconds}`,
          `  max_age_minutes = ${verification.maxAgeMinutes}`,
        );

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
}
