/**
 * Local calendar integration service.
 *
 * macOS: uses `osascript` (AppleScript) for calendar operations
 *   - Triggers the native OS permission dialog automatically on first use
 *   - Shows a native confirmation dialog before adding any event
 *
 * Linux: generates a temporary .ics file and opens it with `xdg-open`
 *   - Universal — works with GNOME Calendar, KDE Organizer, Thunderbird, etc.
 *   - No confirmation dialog (xdg-open hands off to the desktop app)
 */

import { execFile as execFileCb } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SavedAttachment {
  filename: string;
  localPath: string;
  fileUrl: string;
  mimeType: string;
  size: number;
}

export interface LocalCalendarEventInput {
  title: string;
  start: Date;
  end: Date;
  location?: string;
  /** Pre-built rich notes string (from buildCalendarNotes). */
  notes?: string;
  /** Primary meeting URL (Zoom/Teams/Meet etc). */
  url?: string;
  /** Label for the meeting URL provider, e.g. "Zoom". */
  urlLabel?: string;
  /** Minutes before event to show an alert (default: 15). */
  alarmMinutes?: number;
  allDay?: boolean;
  attendeeCount?: number;
  /** Already-saved attachment list (for dialog count display). */
  savedAttachments?: SavedAttachment[];
  /** Pending (not-yet-saved) attachment metadata for dialog display. */
  pendingAttachments?: { filename: string; mimeType: string; size: number }[];
  dialIn?: string;
  meetingId?: string;
  passcode?: string;
  conferenceProvider?: string;
  /** ICS UID for duplicate detection */
  icsUid?: string;
}

export type AddEventStatus = 'added' | 'cancelled' | 'timed_out' | 'no_display' | 'duplicate';

export interface AddEventResult {
  status: AddEventStatus;
  eventId?: string;
  calendarName?: string;
  message: string;
  /** Populated when status is 'duplicate' */
  duplicate?: { eventId: string; calendarName: string };
}

export interface ExistingEventResult {
  found: boolean;
  eventId?: string;
  calendarName?: string;
  start?: string;
}

export interface CalendarInfo {
  id: string;
  name: string;
}

export interface PermissionResult {
  granted: boolean;
  platform: string;
  instructions: string[];
}

// ---------------------------------------------------------------------------
// Helper functions (declared before class to satisfy no-use-before-define)
// ---------------------------------------------------------------------------

interface JXAScriptOptions {
  event: LocalCalendarEventInput;
  calendarName: string;
  alarmMinutes: number;
  attachCount: number;
  attendeeCount: number;
  confirm: boolean;
}

/** @internal Exported for testing. */
export function escapeAS(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Emit AppleScript lines that set an existing date variable to a specific
 * point in time by assigning each component (year, month, day, hours, minutes,
 * seconds) individually.
 *
 * Uses the JS Date's **local-time** getters so the resulting AppleScript date
 * matches the system timezone — the same timezone Calendar.app operates in.
 *
 * This replaces the previous approach of converting to Unix epoch via
 * `date -j … '+%s'` and coercing `(number) as date`, which fails on macOS
 * because AppleScript cannot coerce large integers to dates (error -1700).
 *
 * @internal Exported for testing.
 */
export function dateToAppleScriptLines(varName: string, d: Date): string[] {
  return [
    `set ${varName} to current date`,
    `set year of ${varName} to ${d.getFullYear()}`,
    `set month of ${varName} to ${d.getMonth() + 1}`,
    `set day of ${varName} to ${d.getDate()}`,
    `set hours of ${varName} to ${d.getHours()}`,
    `set minutes of ${varName} to ${d.getMinutes()}`,
    `set seconds of ${varName} to ${d.getSeconds()}`,
  ];
}

function buildAppleScript(opts: JXAScriptOptions): string {
  const { event, calendarName, alarmMinutes, attachCount, attendeeCount, confirm } = opts;

  const title = escapeAS(event.title);
  const location = escapeAS(event.location ?? '');
  const notes = escapeAS(event.notes ?? '');
  const url = escapeAS(event.url ?? '');
  const urlLabel = escapeAS(event.urlLabel ?? event.conferenceProvider ?? '');
  const dialIn = escapeAS(event.dialIn ?? '');
  const meetingId = escapeAS(event.meetingId ?? '');
  const passcode = escapeAS(event.passcode ?? '');
  const calName = escapeAS(calendarName);

  const lines: string[] = [
    `set eventTitle to "${title}"`,
    '',
    ...dateToAppleScriptLines('eventStart', event.start),
    '',
    ...dateToAppleScriptLines('eventEnd', event.end),
    '',
  ];

  if (confirm) {
    const dialogLines: string[] = [`\uD83D\uDCC5 ${title}`];
    dialogLines.push('\uD83D\uDD50 " & (eventStart as text) & " \u2013 " & (eventEnd as text) & "');
    if (location) {
      dialogLines.push(`\uD83D\uDCCD ${location}`);
    }
    if (url) {
      const domain = url.replace(/^https?:\/\//, '').split('/')[0];
      dialogLines.push(`\uD83C\uDFA5 ${urlLabel || domain}`);
    }
    if (dialIn) {
      dialogLines.push(`\uD83D\uDCDE ${dialIn}`);
    }
    if (meetingId) {
      const pin = passcode ? ` \u00B7 PIN: ${passcode}` : '';
      dialogLines.push(`\uD83D\uDD11 ID: ${meetingId}${pin}`);
    }
    if (attendeeCount > 0) {
      dialogLines.push(`\uD83D\uDC65 ${attendeeCount} attendee${attendeeCount > 1 ? 's' : ''}`);
    }
    if (attachCount > 0) {
      dialogLines.push(
        `\uD83D\uDCCE ${attachCount} attachment${attachCount > 1 ? 's' : ''} saved locally`,
      );
    }
    dialogLines.push(
      `\uD83D\uDCC6 ${calName || 'Default Calendar'} \u00B7 \u23F0 ${alarmMinutes} min before`,
    );

    lines.push(`set dialogText to "${escapeAS(dialogLines[0])}"`);
    dialogLines.slice(1).forEach((dl) => {
      lines.push(`set dialogText to dialogText & return & "${escapeAS(dl)}"`);
    });
    lines.push(
      'try',
      '  display dialog dialogText with title "email-mcp \u2014 Add Calendar Event?" buttons {"Cancel", "Add to Calendar"} default button "Add to Calendar" cancel button "Cancel" giving up after 60',
      '  set dlgResult to button returned of result',
      '  if dlgResult is not "Add to Calendar" then',
      '    return "{\\"status\\":\\"timed_out\\"}"',
      '  end if',
      'on error',
      '  return "{\\"status\\":\\"cancelled\\"}"',
      'end try',
      '',
    );
  }

  lines.push('tell application "Calendar"');
  if (calName) {
    lines.push(
      '  try',
      `    set theCal to first calendar whose name is "${calName}"`,
      '  on error',
      '    set theCal to first calendar',
      '  end try',
    );
  } else {
    lines.push('  set theCal to first calendar');
  }
  lines.push('  set eventProps to {summary:eventTitle, start date:eventStart, end date:eventEnd}');
  if (location) {
    lines.push(`  set eventProps to eventProps & {location:"${location}"}`);
  }
  if (notes) {
    lines.push(`  set eventProps to eventProps & {description:"${notes}"}`);
  }
  if (url) {
    lines.push(`  set eventProps to eventProps & {url:"${escapeAS(event.url ?? '')}"}`);
  }
  lines.push(
    '  set theEvent to make new event at end of events of theCal with properties eventProps',
  );
  if (alarmMinutes > 0) {
    lines.push(
      '  try',
      `    make new display alarm at end of display alarms of theEvent with properties {trigger interval:-${alarmMinutes * 60}}`,
      '  end try',
    );
  }
  lines.push(
    '  set eventId to uid of theEvent',
    '  set finalCalName to name of theCal',
    'end tell',
    '',
    'return "{\\"status\\":\\"added\\",\\"eventId\\":\\"" & eventId & "\\",\\"calendarName\\":\\"" & finalCalName & "\\"}"',
  );

  return lines.join('\n');
}

function toICSDate(d: Date): string {
  return `${d.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
}

function escapeICS(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function buildICS(event: LocalCalendarEventInput): string {
  const uid = `email-mcp-${Date.now()}@local`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//email-mcp//email-mcp//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${toICSDate(new Date())}`,
    `DTSTART:${toICSDate(event.start)}`,
    `DTEND:${toICSDate(event.end)}`,
    `SUMMARY:${escapeICS(event.title)}`,
  ];
  if (event.location) lines.push(`LOCATION:${escapeICS(event.location)}`);
  if (event.notes) lines.push(`DESCRIPTION:${escapeICS(event.notes)}`);
  if (event.url) lines.push(`URL:${event.url}`);
  if (event.alarmMinutes) {
    lines.push(
      'BEGIN:VALARM',
      `TRIGGER:-PT${event.alarmMinutes}M`,
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeICS(event.title)}`,
      'END:VALARM',
    );
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}

function statusMessage(status: AddEventStatus, title: string, calName: string | undefined): string {
  switch (status) {
    case 'added':
      return `\u2705 Event added: "${title}" \u2192 ${calName ?? 'calendar'}.`;
    case 'duplicate':
      return `\u26A0\uFE0F Event already exists in ${calName ?? 'calendar'}: "${title}". Skipped.`;
    case 'cancelled':
      return '\uD83D\uDEAB Cancelled \u2014 event was not added to the calendar.';
    case 'timed_out':
      return '\u23F1\uFE0F Dialog timed out after 60 s \u2014 event was not added. Try again.';
    case 'no_display':
      return '\u26A0\uFE0F No display available. Run check_calendar_permissions for setup instructions.';
    default:
      return `Unknown status: ${status as string}`;
  }
}

async function checkPermissionsMacOS(): Promise<PermissionResult> {
  const script = 'tell application "Calendar" to return count of calendars';
  try {
    const { stdout } = await execFile('osascript', ['-e', script], {
      timeout: 10_000,
    });
    const count = parseInt(stdout.trim(), 10);
    if (count >= 0) return { granted: true, platform: 'darwin', instructions: [] };
  } catch {
    // fall through to denied
  }
  return {
    granted: false,
    platform: 'darwin',
    instructions: [
      'Calendar access was denied or unavailable.',
      '1. Open System Settings (Apple menu \u2192 System Settings)',
      '2. Go to Privacy & Security \u2192 Calendars',
      '3. Enable access for Terminal (or your terminal emulator, e.g. iTerm2)',
      '4. Quit and restart the terminal, then try again.',
    ],
  };
}

async function listCalendarsMacOS(): Promise<CalendarInfo[]> {
  const script = 'tell application "Calendar" to return name of every calendar';
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

async function findExistingEventMacOS(
  title: string,
  _start: Date,
  _icsUid?: string,
): Promise<ExistingEventResult> {
  const searchTitle = escapeAS(title);

  const script = `
set searchTitle to "${searchTitle}"
tell application "Calendar"
  repeat with c in calendars
    try
      set evList to (every event of c whose summary is searchTitle)
      if (count of evList) > 0 then
        set theEvent to item 1 of evList
        set eventId to uid of theEvent
        set calName to name of c
        return "{\\"found\\":true,\\"eventId\\":\\"" & eventId & "\\",\\"calendarName\\":\\"" & calName & "\\"}"
      end if
    end try
  end repeat
end tell
return "{\\"found\\":false}"
`;

  try {
    const { stdout } = await execFile('osascript', ['-e', script], {
      timeout: 10_000,
    });
    return JSON.parse(stdout.trim()) as ExistingEventResult;
  } catch {
    return { found: false };
  }
}

async function addEventMacOS(
  event: LocalCalendarEventInput,
  calendarName: string | undefined,
  confirm: boolean,
): Promise<AddEventResult> {
  const alarmMinutes = event.alarmMinutes ?? 15;
  const attachCount =
    (event.savedAttachments?.length ?? 0) + (event.pendingAttachments?.length ?? 0);
  const attendeeCount = event.attendeeCount ?? 0;

  const script = buildAppleScript({
    event,
    calendarName: calendarName ?? '',
    alarmMinutes,
    attachCount,
    attendeeCount,
    confirm,
  });

  try {
    const { stdout } = await execFile('osascript', ['-e', script], {
      timeout: 90_000,
    });
    const result = JSON.parse(stdout.trim()) as {
      status: AddEventStatus;
      eventId?: string;
      calendarName?: string;
      error?: string;
    };
    return {
      status: result.status,
      eventId: result.eventId,
      calendarName: result.calendarName,
      message: statusMessage(result.status, event.title, result.calendarName),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/user canceled|(-128)/i.test(msg)) {
      return { status: 'cancelled', message: 'Cancelled by user.' };
    }
    if (/not authorized|access/i.test(msg)) {
      return {
        status: 'no_display',
        message: 'Calendar access denied. Run check_calendar_permissions for setup instructions.',
      };
    }
    return { status: 'no_display', message: `Could not add event: ${msg}` };
  }
}

async function addEventLinux(
  event: LocalCalendarEventInput,
  _calendarName?: string,
): Promise<AddEventResult> {
  const tmpFile = join(tmpdir(), `email-mcp-event-${Date.now()}.ics`);
  const ics = buildICS(event);
  await writeFile(tmpFile, ics, 'utf8');

  try {
    await execFile('xdg-open', [tmpFile], { timeout: 10_000 });
    return {
      status: 'added',
      message: `Calendar file opened: ${event.title}. Confirm import in your calendar application.`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: 'no_display',
      message: `Could not open calendar app (xdg-open failed): ${msg}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export default class LocalCalendarService {
  private readonly platform = process.platform;

  async checkPermissions(): Promise<PermissionResult> {
    if (this.platform === 'darwin') return checkPermissionsMacOS();
    return { granted: true, platform: 'linux', instructions: [] };
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    if (this.platform !== 'darwin') {
      return [{ id: 'default', name: 'Default Calendar' }];
    }
    return listCalendarsMacOS();
  }

  /** Check all calendars for an existing event matching by ICS UID or title+startDate. */
  async findExistingEvent(
    title: string,
    start: Date,
    icsUid?: string,
  ): Promise<ExistingEventResult> {
    if (this.platform !== 'darwin') return { found: false };
    return findExistingEventMacOS(title, start, icsUid);
  }

  async addEvent(
    event: LocalCalendarEventInput,
    calendarName?: string,
    opts: { confirm?: boolean; skipDuplicateCheck?: boolean } = {},
  ): Promise<AddEventResult> {
    const confirm = opts.confirm !== false;

    // Duplicate detection (macOS only, can opt out)
    if (this.platform === 'darwin' && opts.skipDuplicateCheck !== true) {
      const existing = await findExistingEventMacOS(event.title, event.start, event.icsUid);
      if (existing.found) {
        return {
          status: 'duplicate',
          eventId: existing.eventId,
          calendarName: existing.calendarName,
          message: statusMessage('duplicate', event.title, existing.calendarName),
          duplicate: existing.found
            ? { eventId: existing.eventId ?? '', calendarName: existing.calendarName ?? '' }
            : undefined,
        };
      }
    }

    if (this.platform === 'darwin') {
      return addEventMacOS(event, calendarName, confirm);
    }
    return addEventLinux(event, calendarName);
  }
}
