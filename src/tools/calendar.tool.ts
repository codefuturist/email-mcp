/**
 * MCP Tools: calendar operations
 *
 * - extract_calendar   — parse ICS/iCalendar from email
 * - add_to_calendar    — add email event to local calendar (with confirmation dialog)
 * - check_calendar_permissions — check OS calendar access
 * - list_calendars     — list available local calendars
 */

import { join } from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { CALENDAR_ATTACHMENTS_DIR } from '../config/xdg.js';
import type CalendarService from '../services/calendar.service.js';
import type ImapService from '../services/imap.service.js';
import type LocalCalendarService from '../services/local-calendar.service.js';
import { buildCalendarNotes } from '../utils/calendar-notes.js';
import { extractConferenceDetails } from '../utils/conference-details.js';
import { extractMeetingUrl } from '../utils/meeting-url.js';

export default function registerCalendarTools(
  server: McpServer,
  imapService: ImapService,
  calendarService: CalendarService,
  localCalendarService: LocalCalendarService,
): void {
  // ---------------------------------------------------------------------------
  // extract_calendar
  // ---------------------------------------------------------------------------

  server.tool(
    'extract_calendar',
    'Extract calendar events (ICS/iCalendar) from an email. Returns structured event data including time, location, attendees, and status.',
    {
      account: z.string().describe('Account name'),
      email_id: z.string().describe('Email UID'),
      mailbox: z.string().default('INBOX').describe('Mailbox path (default: INBOX)'),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ account, email_id: emailId, mailbox }) => {
      const email = await imapService.getEmail(account, emailId, mailbox);
      const icsContents = await imapService.getCalendarParts(account, mailbox, emailId);

      if (icsContents.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  email_subject: email.subject,
                  events: [],
                  count: 0,
                  message: 'No calendar/ICS content found in this email',
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      const events = calendarService.extractFromParts(icsContents);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ email_subject: email.subject, events, count: events.length }, null, 2),
          },
        ],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // add_to_calendar
  // ---------------------------------------------------------------------------

  server.tool(
    'add_to_calendar',
    [
      'Add an email event to the local calendar (macOS Calendar.app / Linux via xdg-open).',
      'Automatically extracts event data from the email: ICS attachments, meeting URL (Zoom/Teams/Meet),',
      'conference dial-in / ID / passcode, attendees, and email body excerpt.',
      'All relevant email attachments (PDFs, docs, etc.) are saved locally and linked in the event notes.',
      'A native confirmation dialog is shown on macOS before the event is written.',
      'Returns one of: added | cancelled | timed_out | no_display.',
    ].join(' '),
    {
      account: z.string().describe('Account name'),
      email_id: z.string().describe('Email UID'),
      mailbox: z.string().default('INBOX').describe('Mailbox path (default: INBOX)'),
      calendar_name: z
        .string()
        .optional()
        .describe('Target calendar name (empty = default calendar)'),
      alarm_minutes: z
        .number()
        .int()
        .min(0)
        .max(1440)
        .default(15)
        .describe('Minutes before event to show an alert (default: 15)'),
      save_attachments: z
        .boolean()
        .default(true)
        .describe('Save non-ICS email attachments locally and link them in the event notes'),
      confirm: z
        .boolean()
        .default(true)
        .describe('Show native confirmation dialog before adding (default: true)'),
    },
    { readOnlyHint: false, destructiveHint: false },
    async ({
      account,
      email_id: emailId,
      mailbox,
      calendar_name: calendarName,
      alarm_minutes: alarmMinutes,
      save_attachments: saveAttachments,
      confirm,
    }) => {
      // 1. Fetch full email
      const email = await imapService.getEmail(account, emailId, mailbox);
      const bodyText = email.bodyText ?? '';
      const bodyHtml = email.bodyHtml ?? '';
      const combinedText = `${bodyText}\n${bodyHtml}`;

      // 2. Try to get event data from ICS attachment
      let eventStart: Date = new Date(email.date);
      let eventEnd: Date = new Date(eventStart.getTime() + 60 * 60 * 1000);
      let eventLocation: string | undefined;
      let eventOrganizer: string | undefined;
      let eventAttendees: string[] = [];

      const icsContents = await imapService.getCalendarParts(account, mailbox, emailId);
      if (icsContents.length > 0) {
        const events = calendarService.extractFromParts(icsContents);
        if (events.length > 0) {
          const ev = events[0];
          eventStart = new Date(ev.start);
          eventEnd = new Date(ev.end);
          eventLocation = ev.location;
          if (ev.organizer) {
            eventOrganizer = ev.organizer.name
              ? `${ev.organizer.name} <${ev.organizer.address}>`
              : ev.organizer.address;
          }
          eventAttendees = ev.attendees.map((a) => {
            if (a.name) return `${a.name} <${a.address}>`;
            return a.address;
          });
        }
      }

      // 3. Extract meeting URL and conference details
      const meetingUrl = extractMeetingUrl(combinedText);
      const conference = extractConferenceDetails(bodyText !== '' ? bodyText : bodyHtml);

      // 4. Save attachments (before dialog so filenames are shown)
      let savedAttachments: {
        filename: string;
        localPath: string;
        fileUrl: string;
        mimeType: string;
        size: number;
      }[] = [];

      if (saveAttachments && email.attachments.length > 0) {
        const destDir = join(
          CALENDAR_ATTACHMENTS_DIR,
          `${account}-${emailId}`.replace(/[^a-zA-Z0-9-_]/g, '_'),
        );
        savedAttachments = await imapService.saveEmailAttachments(
          account,
          emailId,
          mailbox,
          destDir,
        );
      }

      // 5. Build rich notes
      const notes = buildCalendarNotes({
        emailFrom: email.from.name
          ? `${email.from.name} <${email.from.address}>`
          : email.from.address,
        emailSubject: email.subject,
        emailDate: new Date(email.date).toLocaleString('en', {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }),
        organizer: eventOrganizer,
        attendees: eventAttendees,
        meetingUrl: meetingUrl?.url,
        meetingUrlLabel: meetingUrl?.label,
        dialIn: conference?.dialIn,
        meetingId: conference?.meetingId,
        passcode: conference?.passcode,
        conferenceProvider: conference?.provider,
        bodyExcerpt: bodyText || bodyHtml,
        savedAttachments,
      });

      // 6. Add to calendar (shows dialog if confirm=true)
      const result = await localCalendarService.addEvent(
        {
          title: email.subject,
          start: eventStart,
          end: eventEnd,
          location: eventLocation,
          notes,
          url: meetingUrl?.url,
          urlLabel: meetingUrl?.label,
          alarmMinutes,
          attendeeCount: eventAttendees.length,
          savedAttachments,
          dialIn: conference?.dialIn,
          meetingId: conference?.meetingId,
          passcode: conference?.passcode,
          conferenceProvider: conference?.provider,
        },
        calendarName,
        { confirm },
      );

      // 7. Build response
      const details: Record<string, unknown> = {
        status: result.status,
        message: result.message,
      };
      if (result.status === 'added') {
        details.event = {
          title: email.subject,
          start: eventStart.toISOString(),
          end: eventEnd.toISOString(),
          location: eventLocation,
          calendar: result.calendarName,
          meetingUrl: meetingUrl?.url,
          dialIn: conference?.dialIn,
          meetingId: conference?.meetingId,
          attachmentsSaved: savedAttachments.length,
          attachments: savedAttachments.map((a) => ({
            filename: a.filename,
            size: a.size,
            localPath: a.localPath,
          })),
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(details, null, 2) }],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // check_calendar_permissions
  // ---------------------------------------------------------------------------

  server.tool(
    'check_calendar_permissions',
    [
      'Check whether the local calendar is accessible.',
      'On macOS, verifies Calendar.app access (requires Privacy & Security → Calendars permission).',
      'Returns granted status and step-by-step setup instructions if access is denied.',
    ].join(' '),
    {},
    { readOnlyHint: true, destructiveHint: false },
    async () => {
      const result = await localCalendarService.checkPermissions();
      const lines = [
        `Platform: ${result.platform}`,
        `Access granted: ${result.granted ? '✅ Yes' : '❌ No'}`,
      ];
      if (!result.granted && result.instructions.length > 0) {
        lines.push('', 'Setup instructions:');
        result.instructions.forEach((line, i) => lines.push(`  ${i === 0 ? '' : `${i}. `}${line}`));
      }
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );

  // ---------------------------------------------------------------------------
  // list_calendars
  // ---------------------------------------------------------------------------

  server.tool(
    'list_calendars',
    [
      'List all available local calendars (macOS Calendar.app / Linux default).',
      'Use the returned calendar names with add_to_calendar to target a specific calendar.',
    ].join(' '),
    {},
    { readOnlyHint: true, destructiveHint: false },
    async () => {
      const calendars = await localCalendarService.listCalendars();
      if (calendars.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No calendars found. Run check_calendar_permissions to verify access.',
            },
          ],
        };
      }
      const lines = [`Found ${calendars.length} calendar(s):`, ''];
      calendars.forEach((c, i) => lines.push(`  ${i + 1}. ${c.name} (id: ${c.id})`));
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );
}
