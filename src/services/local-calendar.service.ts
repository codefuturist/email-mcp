/**
 * Local calendar integration service.
 *
 * macOS: uses `osascript -l JavaScript` (JXA — JavaScript for Automation)
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
}

export type AddEventStatus = 'added' | 'cancelled' | 'timed_out' | 'no_display';

export interface AddEventResult {
  status: AddEventStatus;
  eventId?: string;
  calendarName?: string;
  message: string;
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

function buildJXAScript(opts: JXAScriptOptions): string {
  const { event, calendarName, alarmMinutes, attachCount, attendeeCount, confirm } = opts;

  const t = {
    title: JSON.stringify(event.title),
    start: JSON.stringify(event.start.toISOString()),
    end: JSON.stringify(event.end.toISOString()),
    location: JSON.stringify(event.location ?? ''),
    notes: JSON.stringify(event.notes ?? ''),
    url: JSON.stringify(event.url ?? ''),
    urlLabel: JSON.stringify(event.urlLabel ?? event.conferenceProvider ?? ''),
    calName: JSON.stringify(calendarName),
    dialIn: JSON.stringify(event.dialIn ?? ''),
    meetingId: JSON.stringify(event.meetingId ?? ''),
    passcode: JSON.stringify(event.passcode ?? ''),
    alarmMins: String(alarmMinutes),
    attachCount: String(attachCount),
    attendeeCount: String(attendeeCount),
    confirm: confirm ? 'true' : 'false',
  };

  return `(() => {
  const title       = ${t.title};
  const startDate   = new Date(${t.start});
  const endDate     = new Date(${t.end});
  const location    = ${t.location};
  const notes       = ${t.notes};
  const url         = ${t.url};
  const urlLabel    = ${t.urlLabel};
  const calName     = ${t.calName};
  const dialIn      = ${t.dialIn};
  const meetingId   = ${t.meetingId};
  const passcode    = ${t.passcode};
  const alarmMins   = ${t.alarmMins};
  const attachCount = ${t.attachCount};
  const attendees   = ${t.attendeeCount};
  const doConfirm   = ${t.confirm};

  const app = Application.currentApplication();
  app.includeStandardAdditions = true;
  const Calendar = Application('Calendar');

  if (doConfirm) {
    const fmt = { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
    const startStr = startDate.toLocaleString('en', fmt);
    const endStr   = endDate.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' });
    const lines = [
      '\\uD83D\\uDCC5 ' + title,
      '\\uD83D\\uDD50 ' + startStr + ' \u2013 ' + endStr,
    ];
    if (location)    lines.push('\\uD83D\\uDCCD ' + location);
    if (url) {
      const domain = url.replace(/^https?:\\/\\//, '').split('/')[0];
      lines.push('\\uD83C\\uDFA5 ' + (urlLabel || domain));
    }
    if (dialIn)    lines.push('\\uD83D\\uDCDE ' + dialIn);
    if (meetingId) lines.push('\\uD83D\\uDD11 ID: ' + meetingId + (passcode ? ' \\u00B7 PIN: ' + passcode : ''));
    if (attendees > 0) lines.push('\\uD83D\\uDC65 ' + attendees + ' attendee' + (attendees > 1 ? 's' : ''));
    if (attachCount > 0) lines.push('\\uD83D\\uDCCE ' + attachCount + ' attachment' + (attachCount > 1 ? 's' : '') + ' will be saved locally');
    lines.push('\\uD83D\\uDCC6 ' + (calName || 'Default Calendar') + ' \\u00B7 \\u23F0 ' + alarmMins + ' min before');

    let dlg;
    try {
      dlg = app.displayDialog(lines.join('\\n'), {
        withTitle: 'email-mcp \u2014 Add Calendar Event?',
        buttons: ['Cancel', 'Add to Calendar'],
        defaultButton: 'Add to Calendar',
        cancelButton: 'Cancel',
        givingUpAfter: 60,
      });
    } catch(e) {
      return JSON.stringify({ status: 'cancelled' });
    }
    if (dlg.gaveUp) return JSON.stringify({ status: 'timed_out' });
    if (dlg.buttonReturned !== 'Add to Calendar') return JSON.stringify({ status: 'cancelled' });
  }

  let targetCal;
  try {
    targetCal = calName
      ? Calendar.calendars.whose({ name: calName })[0]
      : Calendar.defaultCalendar;
  } catch(e) {
    targetCal = Calendar.defaultCalendar;
  }
  if (!targetCal) {
    return JSON.stringify({ status: 'no_display', error: 'Calendar not found: ' + calName });
  }

  const props = {
    summary:   title,
    startDate: startDate,
    endDate:   endDate,
  };
  if (location) props.location    = location;
  if (notes)    props.description = notes;
  if (url)      props.url         = url;

  const ev = Calendar.Event(props);
  targetCal.events.push(ev);

  if (alarmMins > 0) {
    try {
      const alarm = Calendar.DisplayAlarm({ triggerInterval: -alarmMins * 60 });
      ev.alarms.push(alarm);
    } catch(e) { /* alarms not supported on this calendar type */ }
  }

  let eventId = '';
  try { eventId = ev.uid(); } catch(e) {}
  let finalCalName = '';
  try { finalCalName = targetCal.name(); } catch(e) {}

  return JSON.stringify({ status: 'added', eventId: eventId, calendarName: finalCalName });
})()`;
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
  const script = `(() => {
    try {
      const cal = Application('Calendar');
      return JSON.stringify({ granted: true, count: cal.calendars().length });
    } catch(e) {
      return JSON.stringify({ granted: false, error: String(e) });
    }
  })()`;
  try {
    const { stdout } = await execFile('osascript', ['-l', 'JavaScript', '-e', script], {
      timeout: 10_000,
    });
    const parsed = JSON.parse(stdout.trim()) as { granted: boolean };
    if (parsed.granted) return { granted: true, platform: 'darwin', instructions: [] };
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
  const script = `(() => {
    try {
      const cal = Application('Calendar');
      return JSON.stringify(
        cal.calendars().map(c => {
          try { return { id: c.uid(), name: c.name() }; } catch(e) { return null; }
        }).filter(Boolean)
      );
    } catch(e) {
      return JSON.stringify([]);
    }
  })()`;
  try {
    const { stdout } = await execFile('osascript', ['-l', 'JavaScript', '-e', script], {
      timeout: 10_000,
    });
    return JSON.parse(stdout.trim()) as CalendarInfo[];
  } catch {
    return [];
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

  const script = buildJXAScript({
    event,
    calendarName: calendarName ?? '',
    alarmMinutes,
    attachCount,
    attendeeCount,
    confirm,
  });

  try {
    const { stdout } = await execFile('osascript', ['-l', 'JavaScript', '-e', script], {
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

  async addEvent(
    event: LocalCalendarEventInput,
    calendarName?: string,
    opts: { confirm?: boolean } = {},
  ): Promise<AddEventResult> {
    const confirm = opts.confirm !== false;
    if (this.platform === 'darwin') {
      return addEventMacOS(event, calendarName, confirm);
    }
    return addEventLinux(event, calendarName);
  }
}
