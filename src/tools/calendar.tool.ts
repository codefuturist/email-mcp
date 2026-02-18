/**
 * MCP Tools: calendar operations
 *
 * - extract_calendar            — parse ICS/iCalendar from email
 * - add_to_calendar             — add email event to local calendar (with confirmation dialog + dedup)
 * - check_calendar_permissions  — check OS calendar/reminders access
 * - list_calendars              — list available local calendars
 * - list_events                 — search/list local calendar events
 * - list_reminders              — search/list reminders from Reminders.app
 * - create_reminder             — create a reminder in macOS Reminders.app from email
 * - analyze_email_for_scheduling — detect events + reminders in email; AI decides what to create
 */

import { join } from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { CALENDAR_ATTACHMENTS_DIR } from '../config/xdg.js';
import type CalendarService from '../services/calendar.service.js';
import type ImapService from '../services/imap.service.js';
import type LocalCalendarService from '../services/local-calendar.service.js';
import type RemindersService from '../services/reminders.service.js';
import { buildCalendarNotes } from '../utils/calendar-notes.js';
import { extractConferenceDetails } from '../utils/conference-details.js';
import { extractMeetingUrl } from '../utils/meeting-url.js';

// Keywords that suggest an action item / reminder rather than a calendar event
const REMINDER_KEYWORDS =
  /\b(deadline|due by|respond by|reply by|action required|follow.?up|please review|please send|please confirm|submit by|complete by|return by|RSVP by|by (monday|tuesday|wednesday|thursday|friday|saturday|sunday)|by (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))\b/i;

export default function registerCalendarTools(
  server: McpServer,
  imapService: ImapService,
  calendarService: CalendarService,
  localCalendarService: LocalCalendarService,
  remindersService: RemindersService,
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
            text: JSON.stringify(
              { email_subject: email.subject, events, count: events.length },
              null,
              2,
            ),
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
      let icsUid: string | undefined;

      const icsContents = await imapService.getCalendarParts(account, mailbox, emailId);
      if (icsContents.length > 0) {
        const events = calendarService.extractFromParts(icsContents);
        if (events.length > 0) {
          const ev = events[0];
          eventStart = new Date(ev.start);
          eventEnd = new Date(ev.end);
          eventLocation = ev.location;
          icsUid = ev.uid;
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

      // 6. Add to calendar (shows dialog if confirm=true, dedup check is automatic)
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
          icsUid,
        },
        calendarName,
        { confirm },
      );

      // 7. Build response
      const details: Record<string, unknown> = {
        status: result.status,
        message: result.message,
      };
      if (result.status === 'duplicate') {
        details.duplicate = result.duplicate;
        details.hint = 'Event already exists. Use skipDuplicateCheck or update the existing event.';
      }
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
      const [calResult, remResult] = await Promise.all([
        localCalendarService.checkPermissions(),
        remindersService.checkPermissions(),
      ]);
      const lines = [
        '--- Calendar.app ---',
        `Platform: ${calResult.platform}`,
        `Access granted: ${calResult.granted ? '✅ Yes' : '❌ No'}`,
      ];
      if (!calResult.granted && calResult.instructions.length > 0) {
        lines.push('', 'Setup instructions:');
        calResult.instructions.forEach((line, i) => {
          lines.push(`  ${i === 0 ? '' : `${i}. `}${line}`);
        });
      }
      lines.push('', '--- Reminders.app ---');
      lines.push(`Access granted: ${remResult.granted ? '✅ Yes' : '❌ No'}`);
      if (!remResult.granted && remResult.instructions.length > 0) {
        lines.push('', 'Setup instructions:');
        remResult.instructions.forEach((line, i) => {
          lines.push(`  ${i === 0 ? '' : `${i}. `}${line}`);
        });
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
      calendars.forEach((c, i) => {
        lines.push(`  ${i + 1}. ${c.name} (id: ${c.id})`);
      });
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );

  // ---------------------------------------------------------------------------
  // list_events
  // ---------------------------------------------------------------------------

  server.tool(
    'list_events',
    [
      'List local calendar events with optional filters.',
      'Search by title, date range, or calendar name.',
      'Use to check for existing events before creating new ones, or to verify a recently added event.',
      'Returns event id, title, start/end time, location, and calendar name.',
    ].join(' '),
    {
      title: z
        .string()
        .optional()
        .describe('Filter events whose title contains this text (case-insensitive)'),
      from: z
        .string()
        .optional()
        .describe(
          'Show events on or after this date (ISO 8601, e.g. 2026-02-19). Defaults to 7 days ago.',
        ),
      to: z
        .string()
        .optional()
        .describe(
          'Show events on or before this date (ISO 8601, e.g. 2026-02-28). Defaults to 30 days from now.',
        ),
      calendar_name: z.string().optional().describe('Restrict to a specific calendar by name'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe('Maximum number of results (default: 20)'),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ title, from, to, calendar_name: calendarName, limit }) => {
      const events = await localCalendarService.listEvents({
        title,
        from,
        to,
        calendarName,
        limit,
      });

      if (events.length === 0) {
        const filterDesc = title ? ` matching "${title}"` : '';
        return {
          content: [
            {
              type: 'text' as const,
              text: `No events found${filterDesc}. Try adjusting the date range or title filter.`,
            },
          ],
        };
      }

      const lines = [`\uD83D\uDCC5 Found ${events.length} event(s):`, ''];
      events.forEach((ev, i) => {
        const loc = ev.location ? ` \uD83D\uDCCD ${ev.location}` : '';
        lines.push(
          `  ${i + 1}. ${ev.title}`,
          `     \uD83D\uDD50 ${ev.start} \u2013 ${ev.end}`,
          `     \uD83D\uDCC6 ${ev.calendar}${loc}`,
          `     ID: ${ev.id}`,
          '',
        );
      });

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );

  // ---------------------------------------------------------------------------
  // list_reminders
  // ---------------------------------------------------------------------------

  server.tool(
    'list_reminders',
    [
      'List reminders from macOS Reminders.app with optional filters.',
      'Search by title or list name. By default only shows incomplete reminders.',
      'Use to check for existing reminders before creating new ones, or to verify a recently added reminder.',
      'Returns reminder id, title, due date, completion status, priority, and list name.',
    ].join(' '),
    {
      title: z
        .string()
        .optional()
        .describe('Filter reminders whose title contains this text (case-insensitive)'),
      list_name: z.string().optional().describe('Restrict to a specific Reminders list by name'),
      include_completed: z
        .boolean()
        .default(false)
        .describe('Include completed reminders (default: false)'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe('Maximum number of results (default: 20)'),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ title, list_name: listName, include_completed: includeCompleted, limit }) => {
      const reminders = await remindersService.listReminders({
        title,
        listName,
        includeCompleted,
        limit,
      });

      if (reminders.length === 0) {
        const filterDesc = title ? ` matching "${title}"` : '';
        return {
          content: [
            {
              type: 'text' as const,
              text: `No reminders found${filterDesc}. Try adjusting the title filter or set include_completed=true.`,
            },
          ],
        };
      }

      const lines = [`\uD83D\uDD14 Found ${reminders.length} reminder(s):`, ''];
      reminders.forEach((r, i) => {
        const status = r.completed ? '\u2705' : '\u2B1C';
        const due = r.dueDate ? ` \uD83D\uDD50 ${r.dueDate}` : '';
        const priority = r.priority !== 'none' ? ` \u26A0\uFE0F ${r.priority}` : '';
        lines.push(
          `  ${i + 1}. ${status} ${r.title}`,
          `     \uD83D\uDCCB ${r.list}${due}${priority}`,
          `     ID: ${r.id}`,
          '',
        );
      });

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );

  // ---------------------------------------------------------------------------
  // create_reminder
  // ---------------------------------------------------------------------------

  server.tool(
    'create_reminder',
    [
      'Create a reminder in macOS Reminders.app from an email.',
      'Shows a native confirmation dialog before adding.',
      'Use for action items, deadlines, and follow-up tasks extracted from emails.',
      'Use analyze_email_for_scheduling first to let the AI decide if a reminder is appropriate.',
    ].join(' '),
    {
      account: z.string().describe('Email account name'),
      email_id: z.string().describe('Email ID from list_emails_metadata'),
      mailbox: z.string().default('INBOX').describe('Mailbox containing the email'),
      title: z.string().optional().describe('Reminder title (defaults to email subject)'),
      notes: z
        .string()
        .optional()
        .describe('Reminder body/notes (defaults to auto-built from email)'),
      due_date: z
        .string()
        .optional()
        .describe('ISO 8601 due date (e.g. 2026-02-20T10:00:00). Leave empty for no due date.'),
      priority: z
        .enum(['none', 'low', 'medium', 'high'])
        .default('none')
        .describe('Reminder priority'),
      list_name: z.string().optional().describe('Reminders list name (default list if omitted)'),
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
      title,
      notes,
      due_date,
      priority,
      list_name,
      confirm,
    }) => {
      const email = await imapService.getEmail(account, emailId, mailbox);
      const bodyText = email.bodyText ?? '';
      const bodyHtml = email.bodyHtml ?? '';

      const reminderTitle = title ?? email.subject;
      const from = email.from.name
        ? `${email.from.name} <${email.from.address}>`
        : email.from.address;
      const snippet = (bodyText !== '' ? bodyText : bodyHtml).substring(0, 400).trim();
      const reminderNotes =
        notes ??
        [`\uD83D\uDCE7 From: ${from}`, `\uD83D\uDCCC Subject: ${email.subject}`, '', snippet]
          .filter(Boolean)
          .join('\n');

      const result = await remindersService.addReminder(
        {
          title: reminderTitle,
          notes: reminderNotes,
          dueDate: due_date,
          priority,
          listName: list_name,
        },
        { confirm },
      );

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // analyze_email_for_scheduling
  // ---------------------------------------------------------------------------

  server.tool(
    'analyze_email_for_scheduling',
    [
      'Analyze an email to detect calendar events and/or reminder-worthy content.',
      'Returns structured analysis so the AI can decide whether to call add_to_calendar,',
      'create_reminder, both, or neither.',
      'Use this as the first step before creating any scheduling resource.',
    ].join(' '),
    {
      account: z.string().describe('Email account name'),
      email_id: z.string().describe('Email ID from list_emails_metadata'),
      mailbox: z.string().default('INBOX').describe('Mailbox containing the email'),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ account, email_id: emailId, mailbox }) => {
      const email = await imapService.getEmail(account, emailId, mailbox);
      const bodyText = email.bodyText ?? '';
      const bodyHtml = email.bodyHtml ?? '';
      const combined = `${bodyText}\n${bodyHtml}`;

      // Check for ICS event
      const icsContents = await imapService.getCalendarParts(account, mailbox, emailId);
      let detectedEvent: Record<string, unknown> | null = null;
      if (icsContents.length > 0) {
        const events = calendarService.extractFromParts(icsContents);
        if (events.length > 0) {
          const ev = events[0];
          detectedEvent = {
            source: 'ics_attachment',
            confidence: 'high',
            title: ev.summary,
            start: ev.start,
            end: ev.end,
            location: ev.location,
            uid: ev.uid,
            organizer: ev.organizer?.address,
            attendees: ev.attendees.map((a) => a.address),
          };
        }
      }

      // Meeting URL detection
      const meetingUrl = extractMeetingUrl(combined);
      if (!detectedEvent && meetingUrl) {
        detectedEvent = {
          source: 'meeting_url',
          confidence: 'medium',
          title: email.subject,
          start: email.date,
          end: new Date(new Date(email.date).getTime() + 60 * 60 * 1000).toISOString(),
          meetingUrl: meetingUrl.url,
          provider: meetingUrl.label,
        };
      }

      // Conference details
      const conference = extractConferenceDetails(bodyText !== '' ? bodyText : bodyHtml);

      // Reminder signal detection
      const reminderMatch = REMINDER_KEYWORDS.exec(combined);
      const detectedReminder = reminderMatch
        ? {
            confidence: 'medium',
            keyword: reminderMatch[0],
            title: email.subject,
            suggestedNotes: `From: ${email.from.address}\n\n${(bodyText !== '' ? bodyText : bodyHtml).substring(0, 300)}`,
          }
        : null;

      // Check if already processed by hooks
      const { isCalendarProcessed, listCalendarProcessed } = await import(
        '../utils/calendar-state.js'
      );
      const alreadyProcessed = await isCalendarProcessed(account, emailId);
      const processedList = alreadyProcessed ? await listCalendarProcessed() : [];
      const processedEntry = processedList.find(({ key }) => key.includes(emailId));

      let recommendation: string;
      if (detectedEvent && detectedReminder) {
        recommendation = 'both';
      } else if (detectedEvent) {
        recommendation = 'event';
      } else if (detectedReminder) {
        recommendation = 'reminder';
      } else {
        recommendation = 'none';
      }

      const analysis = {
        emailId,
        subject: email.subject,
        from: email.from.address,
        date: email.date,
        attachmentCount: email.attachments.length,
        recommendation,
        alreadyAutoProcessed: alreadyProcessed,
        autoProcessedEntry: processedEntry?.entry ?? null,
        detectedEvent,
        detectedReminder,
        conferenceDetails: conference ?? null,
        availableActions: {
          add_to_calendar: detectedEvent !== null || meetingUrl !== undefined,
          create_reminder: detectedReminder !== null,
        },
        instructions: [
          detectedEvent
            ? `Call add_to_calendar(account="${account}", email_id="${emailId}") to add the event.`
            : null,
          detectedReminder
            ? `Call create_reminder(account="${account}", email_id="${emailId}") to add the reminder.`
            : null,
          alreadyProcessed
            ? '\u26A0\uFE0F This email was already auto-processed once by the hook system. You are explicitly choosing to process it again.'
            : null,
        ].filter(Boolean),
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(analysis, null, 2) }],
      };
    },
  );
}
