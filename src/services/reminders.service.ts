/**
 * macOS Reminders.app integration via AppleScript.
 *
 * Lets the AI create reminders from email content — action items, deadlines,
 * follow-ups, etc. — with a native confirmation dialog before adding.
 *
 * Linux: no-op (Reminders.app is macOS-only). Returns a clear error.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReminderPriority = 'none' | 'low' | 'medium' | 'high';

export interface ReminderInput {
  title: string;
  notes?: string;
  /** ISO date string for when the reminder should fire */
  dueDate?: string;
  priority?: ReminderPriority;
  /** Name of the Reminders list to add to (default list if omitted) */
  listName?: string;
}

export type AddReminderStatus = 'added' | 'cancelled' | 'timed_out' | 'no_display';

export interface AddReminderResult {
  status: AddReminderStatus;
  reminderId?: string;
  listName?: string;
  message: string;
}

export interface ReminderListInfo {
  id: string;
  name: string;
}

export interface ReminderSummary {
  id: string;
  title: string;
  dueDate?: string;
  completed: boolean;
  priority: string;
  list: string;
}

export interface ListRemindersOptions {
  /** Filter reminders whose title contains this substring (case-insensitive). */
  title?: string;
  /** Restrict to a specific Reminders list by name. */
  listName?: string;
  /** Include completed reminders (default: false). */
  includeCompleted?: boolean;
  /** Maximum number of results (default 20). */
  limit?: number;
}

// ---------------------------------------------------------------------------
// AppleScript priority mapping: none=0, low=9, medium=5, high=1
// ---------------------------------------------------------------------------

const PRIORITY_MAP: Record<ReminderPriority, number> = {
  none: 0,
  low: 9,
  medium: 5,
  high: 1,
};

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

function reminderStatusMessage(
  status: AddReminderStatus,
  title: string,
  listName: string | undefined,
): string {
  switch (status) {
    case 'added':
      return `\u2705 Reminder added: "${title}" \u2192 ${listName ?? 'Reminders'}.`;
    case 'cancelled':
      return '\uD83D\uDEAB Cancelled \u2014 reminder was not added.';
    case 'timed_out':
      return '\u23F1\uFE0F Dialog timed out \u2014 reminder was not added. Try again.';
    case 'no_display':
      return '\u26A0\uFE0F Cannot add reminder: run check_calendar_permissions to verify access.';
    default:
      return `Unknown status: ${status as string}`;
  }
}

async function checkPermissionsMacOS(): Promise<boolean> {
  const script = 'tell application "Reminders" to return count of lists';
  try {
    const { stdout } = await execFile('osascript', ['-e', script], {
      timeout: 10_000,
    });
    return parseInt(stdout.trim(), 10) >= 0;
  } catch {
    return false;
  }
}

async function listListsMacOS(): Promise<ReminderListInfo[]> {
  const script = 'tell application "Reminders" to return name of every list';
  try {
    const { stdout } = await execFile('osascript', ['-e', script], {
      timeout: 10_000,
    });
    const raw = stdout.trim();
    if (!raw) return [];
    return raw.split(', ').map((name) => ({ id: name, name }));
  } catch {
    return [];
  }
}

function escapeAS(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildReminderAppleScript(input: ReminderInput, confirm: boolean): string {
  const priority = PRIORITY_MAP[input.priority ?? 'none'];
  const title = escapeAS(input.title);
  const notes = escapeAS(input.notes ?? '');
  const dueDate = input.dueDate ?? '';
  const listName = escapeAS(input.listName ?? '');

  const lines: string[] = [];

  if (confirm) {
    const dlgParts: string[] = [`\uD83D\uDD14 ${title}`];
    if (dueDate) {
      dlgParts.push(`\uD83D\uDD50 Due: ${dueDate}`);
    }
    if (notes) {
      const short = notes.length > 200 ? `${notes.substring(0, 200)}\u2026` : notes;
      dlgParts.push(`\uD83D\uDCDD ${short}`);
    }
    if (listName) {
      dlgParts.push(`\uD83D\uDCCB List: ${listName}`);
    }
    if (priority > 0) {
      let pLabel = 'Low';
      if (priority <= 2) {
        pLabel = 'High';
      } else if (priority <= 6) {
        pLabel = 'Medium';
      }
      dlgParts.push(`\u26A0\uFE0F Priority: ${pLabel}`);
    }

    lines.push(`set dialogText to "${escapeAS(dlgParts[0])}"`);
    dlgParts.slice(1).forEach((dl) => {
      lines.push(`set dialogText to dialogText & return & "${escapeAS(dl)}"`);
    });
    lines.push(
      'try',
      '  display dialog dialogText with title "email-mcp \u2014 Add Reminder?" buttons {"Cancel", "Add Reminder"} default button "Add Reminder" cancel button "Cancel" giving up after 60',
      '  set dlgResult to button returned of result',
      '  if dlgResult is not "Add Reminder" then',
      '    return "{\\"status\\":\\"timed_out\\"}"',
      '  end if',
      'on error',
      '  return "{\\"status\\":\\"cancelled\\"}"',
      'end try',
      '',
    );
  }

  lines.push('tell application "Reminders"');
  if (listName) {
    lines.push(
      '  try',
      `    set targetList to list "${listName}"`,
      '  on error',
      '    set targetList to default list',
      '  end try',
    );
  } else {
    lines.push('  set targetList to default list');
  }

  const propsParts = [`name:"${title}", completed:false`];
  if (notes) {
    propsParts.push(`body:"${notes}"`);
  }
  if (priority > 0) {
    propsParts.push(`priority:${priority}`);
  }
  const propsStr = `{${propsParts.join(', ')}}`;

  lines.push(
    `  set newReminder to make new reminder at end of reminders of targetList with properties ${propsStr}`,
  );

  if (dueDate) {
    const d = new Date(dueDate);
    lines.push(
      '  try',
      '    set dueD to current date',
      `    set year of dueD to ${d.getFullYear()}`,
      `    set month of dueD to ${d.getMonth() + 1}`,
      `    set day of dueD to ${d.getDate()}`,
      `    set hours of dueD to ${d.getHours()}`,
      `    set minutes of dueD to ${d.getMinutes()}`,
      `    set seconds of dueD to ${d.getSeconds()}`,
      '    set due date of newReminder to dueD',
      '  end try',
    );
  }

  lines.push(
    '  set remId to id of newReminder',
    '  set finalList to name of targetList',
    'end tell',
    '',
    'return "{\\"status\\":\\"added\\",\\"reminderId\\":\\"" & remId & "\\",\\"listName\\":\\"" & finalList & "\\"}"',
  );

  return lines.join('\n');
}

async function addReminderMacOS(
  input: ReminderInput,
  confirm: boolean,
): Promise<AddReminderResult> {
  const script = buildReminderAppleScript(input, confirm);

  try {
    const { stdout } = await execFile('osascript', ['-e', script], {
      timeout: 90_000,
    });
    const result = JSON.parse(stdout.trim()) as {
      status: AddReminderStatus;
      reminderId?: string;
      listName?: string;
    };
    return {
      status: result.status,
      reminderId: result.reminderId,
      listName: result.listName,
      message: reminderStatusMessage(result.status, input.title, result.listName),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/user canceled|(-128)/i.test(msg)) {
      return { status: 'cancelled', message: 'Cancelled by user.' };
    }
    if (/not authorized|access/i.test(msg)) {
      return {
        status: 'no_display',
        message:
          'Reminders access denied. Go to System Settings \u2192 Privacy \u2192 Reminders and enable Terminal.',
      };
    }
    return { status: 'no_display', message: `Could not add reminder: ${msg}` };
  }
}

async function listRemindersMacOS(opts: ListRemindersOptions): Promise<ReminderSummary[]> {
  const limit = opts.limit ?? 20;
  const titleFilter = opts.title ? escapeAS(opts.title) : '';
  const listFilter = opts.listName ? escapeAS(opts.listName) : '';
  const includeCompleted = opts.includeCompleted === true;

  const script = `
set jsonResult to "["
set resultCount to 0
set maxResults to ${limit}
set titleFilter to "${titleFilter}"
set listFilter to "${listFilter}"
set includeCompleted to ${includeCompleted}

tell application "Reminders"
  repeat with rl in lists
    if resultCount \u2265 maxResults then exit repeat
    set listName to name of rl
    if listFilter is "" or listName is listFilter then
      try
        set rems to every reminder of rl
        repeat with r in rems
          if resultCount \u2265 maxResults then exit repeat
          set isComp to completed of r
          if includeCompleted or not isComp then
            set rTitle to name of r
            set matchesTitle to true
            if titleFilter is not "" then
              ignoring case
                if rTitle does not contain titleFilter then set matchesTitle to false
              end ignoring
            end if
            if matchesTitle then
              set rId to id of r
              set rDue to ""
              try
                set dd to due date of r
                if dd is not missing value then
                  set rDue to (dd as text)
                end if
              end try
              set rPriority to priority of r
              set pLabel to "none"
              if rPriority is 1 then set pLabel to "high"
              if rPriority is 5 then set pLabel to "medium"
              if rPriority is 9 then set pLabel to "low"
              set compStr to "false"
              if isComp then set compStr to "true"
              if resultCount > 0 then set jsonResult to jsonResult & ","
              set jsonResult to jsonResult & "{\\"id\\":\\"" & rId & "\\",\\"title\\":\\"" & rTitle & "\\",\\"dueDate\\":\\"" & rDue & "\\",\\"completed\\":" & compStr & ",\\"priority\\":\\"" & pLabel & "\\",\\"list\\":\\"" & listName & "\\"}"
              set resultCount to resultCount + 1
            end if
          end if
        end repeat
      end try
    end if
  end repeat
end tell

set jsonResult to jsonResult & "]"
return jsonResult
`;

  try {
    const { stdout } = await execFile('osascript', ['-e', script], { timeout: 15_000 });
    return JSON.parse(stdout.trim()) as ReminderSummary[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export default class RemindersService {
  private readonly platform = process.platform;

  get isSupported(): boolean {
    return this.platform === 'darwin';
  }

  async checkPermissions(): Promise<{
    granted: boolean;
    platform: string;
    instructions: string[];
  }> {
    if (this.platform !== 'darwin') {
      return {
        granted: false,
        platform: this.platform,
        instructions: ['Reminders.app is only available on macOS.'],
      };
    }
    const granted = await checkPermissionsMacOS();
    if (granted) return { granted: true, platform: 'darwin', instructions: [] };
    return {
      granted: false,
      platform: 'darwin',
      instructions: [
        'Reminders access was denied or unavailable.',
        '1. Open System Settings \u2192 Privacy & Security \u2192 Reminders',
        '2. Enable access for Terminal (or your terminal emulator)',
        '3. Quit and restart the terminal, then try again.',
      ],
    };
  }

  async listLists(): Promise<ReminderListInfo[]> {
    if (this.platform !== 'darwin') return [];
    return listListsMacOS();
  }

  async addReminder(
    input: ReminderInput,
    opts: { confirm?: boolean } = {},
  ): Promise<AddReminderResult> {
    if (this.platform !== 'darwin') {
      return {
        status: 'no_display',
        message: 'Reminders.app is only available on macOS.',
      };
    }
    const confirm = opts.confirm !== false;
    return addReminderMacOS(input, confirm);
  }

  /** List reminders matching the given filters. */
  async listReminders(opts: ListRemindersOptions = {}): Promise<ReminderSummary[]> {
    if (this.platform !== 'darwin') return [];
    return listRemindersMacOS(opts);
  }
}
