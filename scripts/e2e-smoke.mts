/**
 * Smoke test: drives every registered MCP tool over stdio against a live account.
 *
 * Talks the real protocol to `dist/main.js`, so it covers registration, schema
 * validation, handler execution and serialization — everything a real MCP
 * client hits, and things the GreenMail integration suite cannot reach
 * (provider quirks, real MIME, macOS Calendar bridges).
 *
 * Needs a configured account and a reachable server, so it is deliberately not
 * part of `pnpm test` or CI. Run it by hand after changing a read or write path:
 *
 *     pnpm build && pnpm smoke              # uses the first configured account
 *     E2E_ACCOUNT=work pnpm smoke           # or name one
 *
 * Writes are confined to a scratch folder and a draft it creates itself, and
 * every mutation is recorded in the audit log. It does not exercise tools with
 * side effects outside the mailbox (Calendar, Reminders, notifications) or
 * reply_email, which would send mail to a real third party.
 */

import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ACCOUNT = process.env.E2E_ACCOUNT ?? '';
// ProtonMail Bridge refuses root-level mailboxes; folders live under Folders/.
const SCRATCH = 'Folders/E2EScratch';

interface Outcome {
  tool: string;
  status: 'ok' | 'error' | 'skipped';
  note: string;
}

const results: Outcome[] = [];
let SELF = '';
let client: Client;

/** The parts of a CallToolResult this script reads. */
interface ToolResult {
  content?: { type: string; text?: string }[];
  isError?: boolean;
}

/** A tool call that succeeded, with its text content already flattened. */
interface Called {
  res: ToolResult;
  body: string;
}

function textOf(res: ToolResult): string {
  return (res.content ?? [])
    .map((c) => (c.type === 'text' ? (c.text ?? '') : `<${c.type}>`))
    .join('\n');
}

async function call(tool: string, args: Record<string, unknown> = {}): Promise<Called> {
  const res = (await client.callTool({ name: tool, arguments: args })) as ToolResult;
  const body = textOf(res);
  if (res.isError) throw new Error(body.slice(0, 300));
  return { res, body };
}

/**
 * Run a tool and record the outcome; never throws.
 *
 * `check` returns a complaint string when the response is wrong, or nothing
 * when it is fine — so a tool that answers without erroring can still fail.
 */
async function probe(
  tool: string,
  args: Record<string, unknown>,
  check?: (body: string, res: ToolResult) => string | undefined,
): Promise<Called | null> {
  try {
    const { res, body } = await call(tool, args);
    const complaint = check?.(body, res);
    results.push({
      tool,
      status: complaint ? 'error' : 'ok',
      note: complaint || body.replace(/\s+/g, ' ').slice(0, 90),
    });
    return { res, body };
  } catch (err) {
    results.push({
      tool,
      status: 'error',
      note: (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 160),
    });
    return null;
  }
}

function skip(tool: string, why: string): void {
  results.push({ tool, status: 'skipped', note: why });
}

// ---------------------------------------------------------------------------

const transport = new StdioClientTransport({
  command: 'node',
  // Resolved from the repo root, not from this file's directory.
  args: [fileURLToPath(new URL('../dist/main.js', import.meta.url)), 'stdio'],
  stderr: 'ignore',
});
client = new Client({ name: 'e2e-harness', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);

const { tools } = await client.listTools();
const registered = new Set(tools.map((t) => t.name));
console.log(`connected — ${tools.length} tools registered\n`);

// --- read: accounts & mailboxes -------------------------------------------
const accountsOut = await probe('list_accounts', {}, (b) =>
  !ACCOUNT || b.includes(ACCOUNT) ? undefined : `account "${ACCOUNT}" not configured`,
);
SELF = accountsOut?.body.match(/[\w.+-]+@[\w.-]+\.\w+/)?.[0] ?? '';
if (!SELF) throw new Error('could not determine the account address');
const account = ACCOUNT || accountsOut?.body.match(/•\s*([^:]+):/)?.[1]?.trim() || '';
if (!account) throw new Error('no account configured — run `email-mcp account add` first');
await probe('list_mailboxes', { account }, (b) => (b.includes('INBOX') ? undefined : 'no INBOX'));
await probe('check_health', { account }, (b) =>
  b.includes('"connected": true') || b.includes('"connected":true') ? undefined : 'not connected',
);

// --- read: listing & search -----------------------------------------------
const listed = await probe('list_emails', { account, mailbox: 'INBOX', pageSize: 3 });
const firstId = listed?.body.match(/\[(\d+)\]/)?.[1];
if (!firstId) throw new Error('could not determine a message id to test with');

await probe('list_emails', { account, mailbox: 'INBOX', pageSize: 2, page: 2 });
await probe('list_emails', { account, mailbox: 'INBOX', pageSize: 2, seen: false });
await probe('list_emails', { account, mailbox: 'INBOX', pageSize: 2, has_attachment: true });
await probe('search_emails', { account, mailbox: 'INBOX', query: 'Rechnung', pageSize: 3 });
await probe('search_emails', { account, mailbox: 'INBOX', query: '', pageSize: 2 });

// --- read: single message --------------------------------------------------
await probe(
  'get_email',
  { account, emailId: firstId, mailbox: 'INBOX', format: 'text', maxLength: 200 },
  (b) => {
    if (/=[0-9A-F]{2}\b/.test(b)) return 'quoted-printable artifacts in body';
    if (/&(#\d+|[a-z]+);/i.test(b)) return 'undecoded HTML entities in body';
    return undefined;
  },
);
await probe('get_email', { account, emailId: firstId, mailbox: 'INBOX', format: 'full' }, (b) =>
  /Message-ID:/i.test(b) ? undefined : 'Message-ID is not labelled unambiguously',
);
await probe('get_email', { account, emailId: firstId, mailbox: 'INBOX', format: 'stripped' });
await probe('get_emails', { account, ids: [firstId], mailbox: 'INBOX', format: 'text' });
await probe('get_email_status', { account, emailId: firstId, mailbox: 'INBOX' });
await probe('find_email_folder', { account, emailId: firstId, sourceMailbox: 'INBOX' });

// --- read: aggregate -------------------------------------------------------
await probe('extract_contacts', { account, mailbox: 'INBOX', limit: 20 });
await probe('get_email_stats', { account, mailbox: 'INBOX', period: 'week' });
await probe('list_labels', { account });

// --- read: threads & attachments ------------------------------------------
const withMsgId = await probe('get_email', {
  account,
  emailId: firstId,
  mailbox: 'INBOX',
  format: 'text',
  maxLength: 100,
});
// Anchor on the label: a bare <...@...> match picks up the From address,
// which is not a Message-ID and makes get_thread look broken when it isn't.
const msgId = withMsgId?.body.match(/Message-ID:\s*(<[^>\s]+>)/i)?.[1];
if (msgId) {
  await probe('get_thread', { account, message_id: msgId, mailbox: 'INBOX', maxLength: 200 });
} else {
  skip('get_thread', 'no Message-ID exposed by get_email output');
}

const attach = await probe('list_emails', { account, mailbox: 'Labels/Attachments', pageSize: 1 });
const attachId = attach?.body.match(/\[(\d+)\]/)?.[1];
if (attachId) {
  const detail = await probe('get_email', {
    account,
    emailId: attachId,
    mailbox: 'Labels/Attachments',
    format: 'text',
    maxLength: 100,
  });
  const filename = detail?.body.match(/📎\s*Attachments:\s*([^(,]+?)\s*\(/i)?.[1];
  if (filename) {
    await probe('download_attachment', {
      account,
      id: attachId,
      mailbox: 'Labels/Attachments',
      filename,
    });
  } else {
    skip('download_attachment', 'no attachment filename parsed from get_email output');
  }
} else {
  skip('download_attachment', 'no message in Labels/Attachments');
}

// --- read: calendar --------------------------------------------------------
await probe('extract_calendar', { account, email_id: firstId, mailbox: 'INBOX' });
await probe('analyze_email_for_scheduling', { account, email_id: firstId, mailbox: 'INBOX' });
await probe('check_calendar_permissions', {});
await probe('list_calendars', {});
await probe('list_events', { limit: 3 });
await probe('list_reminders', { limit: 3 });

// --- read: local state -----------------------------------------------------
await probe('list_templates', {});
await probe('list_scheduled', { status: 'all' });
await probe('get_watcher_status', {});
await probe('list_presets', {});
await probe('get_hooks_config', {});
await probe('check_notification_setup', {});

// --- writes: mailbox lifecycle (scratch folder) ----------------------------
await probe('create_mailbox', { account, path: SCRATCH });
const draftOut = await probe('save_draft', {
  account,
  to: [SELF],
  subject: '[E2E] draft',
  body: 'draft body',
});
// Send to the account's own address; e2e@example.test is not deliverable
// locally, so nothing would come back to act on.
await probe('send_email', { account, to: [SELF], subject: '[E2E] sent', body: 'sent body' });

// Write tools act on the draft rather than on sent mail. APPEND is local and
// immediate, whereas a self-addressed send leaves through the provider and may
// take minutes or bounce — which made this section skip silently.
const draftId = draftOut?.body.match(/ID:\s*(\d+)/)?.[1];
const draftBox = draftOut?.body.match(/folder:\s*([^)]+)\)/)?.[1]?.trim();

if (draftId && draftBox) {
  await probe('mark_email', { account, id: draftId, mailbox: draftBox, action: 'read' });
  await probe('mark_email', { account, id: draftId, mailbox: draftBox, action: 'flag' });
  await probe('get_email_status', { account, emailId: draftId, mailbox: draftBox }, (b) =>
    /Flagged/i.test(b) ? undefined : 'flag set by mark_email is not reflected in status',
  );

  // A label here is a folder on this server, so it must exist first — which is
  // exactly what add_label's error now tells the caller.
  await probe('create_label', { account, name: 'E2ELabel' });
  await probe('add_label', { account, emailId: draftId, mailbox: draftBox, label: 'E2ELabel' });
  await probe('remove_label', { account, emailId: draftId, mailbox: draftBox, label: 'E2ELabel' });
  await probe('delete_label', { account, name: 'E2ELabel' });

  await probe('forward_email', {
    account,
    emailId: draftId,
    mailbox: draftBox,
    to: [SELF],
    body: 'fwd',
  });
  await probe('move_email', {
    account,
    emailId: draftId,
    sourceMailbox: draftBox,
    destinationMailbox: SCRATCH,
  });

  // move_email changes the UID, so re-locate the message in its new home.
  const moved = await probe('list_emails', { account, mailbox: SCRATCH, pageSize: 1 });
  const movedId = moved?.body.match(/\[(\d+)\]/)?.[1];
  if (movedId) {
    await probe('bulk_action', {
      account,
      mailbox: SCRATCH,
      action: 'mark_read',
      ids: [Number(movedId)],
    });
    await probe('delete_email', { account, emailId: movedId, mailbox: SCRATCH, permanent: true });
  } else {
    skip('bulk_action', 'moved message not found in scratch folder');
    skip('delete_email', 'moved message not found in scratch folder');
  }
} else {
  for (const t of [
    'mark_email',
    'add_label',
    'remove_label',
    'forward_email',
    'move_email',
    'bulk_action',
    'delete_email',
  ]) {
    skip(t, 'save_draft did not report an id and folder to act on');
  }
}

// reply_email addresses the original sender. Every candidate in this mailbox is
// a real third party, so exercising it would send them mail.
skip('reply_email', 'would send mail to a real third-party sender');

await probe('create_label', { account, name: 'E2ETempLabel' });
await probe('delete_label', { account, name: 'E2ETempLabel' });
await probe('rename_mailbox', { account, path: SCRATCH, new_path: `${SCRATCH}2` });
await probe('delete_mailbox', { account, path: `${SCRATCH}2` });

// --- writes: templates & scheduling ---------------------------------------
await probe('apply_template', {
  account: account,
  template: 'meeting-followup',
  action: 'preview',
  variables: { name: 'Colin', topic: 'E2E', next_steps: 'none', sender: 'Harness' },
});
const sched = await probe('schedule_email', {
  account: account,
  to: [SELF],
  subject: '[E2E] scheduled',
  body: 'later',
  send_at: new Date(Date.now() + 86_400_000).toISOString(),
});
const schedId = sched?.body.match(/[0-9a-f]{8}-[0-9a-f-]{27}|id["':\s]+([\w-]+)/i)?.[0];
if (schedId) {
  await probe('cancel_scheduled', { schedule_id: schedId.replace(/^id["':\s]+/i, '') });
} else {
  skip('cancel_scheduled', 'could not parse schedule id');
}

// --- writes: OS side effects (deliberately not exercised) ------------------
skip('add_to_calendar', 'writes to the real macOS Calendar');
skip('create_reminder', 'writes to the real macOS Reminders');
skip('test_notification', 'fires a desktop notification');
skip('configure_alerts', 'mutates runtime hook configuration');
skip('send_draft', 'consumes the saved draft; covered by integration suite');

// ---------------------------------------------------------------------------

await client.close();

const covered = new Set(results.map((r) => r.tool));
const untested = [...registered].filter((t) => !covered.has(t)).sort();

console.log('=== RESULTS ===');
for (const r of results) {
  const mark = r.status === 'ok' ? '✅' : r.status === 'skipped' ? '⏭️ ' : '❌';
  console.log(`${mark} ${r.tool.padEnd(30)} ${r.note}`);
}
const ok = results.filter((r) => r.status === 'ok').length;
const bad = results.filter((r) => r.status === 'error');
console.log(
  `\npassed ${ok} | failed ${bad.length} | skipped ${results.filter((r) => r.status === 'skipped').length}`,
);
console.log(
  `registered tools never invoked (${untested.length}): ${untested.join(', ') || 'none'}`,
);
if (bad.length) {
  console.log('\n=== FAILURES ===');
  bad.forEach((f) => {
    console.log(`  ${f.tool}: ${f.note}`);
  });
  // Exit non-zero so this is usable as a gate, not just something to read.
  process.exitCode = 1;
}
