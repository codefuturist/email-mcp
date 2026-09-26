/**
 * Build rich calendar event notes from all available email + conference data.
 * The resulting string is stored in the calendar event's description/notes field.
 */

import { stripHtml } from './html.js';

export interface CalendarNotesInput {
  emailFrom?: string;
  emailSubject?: string;
  emailDate?: string;
  attendees?: string[];
  organizer?: string;
  dialIn?: string;
  meetingId?: string;
  passcode?: string;
  conferenceProvider?: string;
  meetingUrl?: string;
  meetingUrlLabel?: string;
  bodyExcerpt?: string;
  savedAttachments?: { filename: string; fileUrl: string; size: number }[];
  pendingAttachments?: { filename: string; mimeType: string; size: number }[];
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Build the full rich notes string for a calendar event. */
export function buildCalendarNotes(input: CalendarNotesInput): string {
  const sections: string[] = [];

  // Email origin
  const originLines: string[] = [];
  if (input.emailFrom) originLines.push(`📧 From: ${input.emailFrom}`);
  if (input.emailSubject) originLines.push(`📧 Subject: ${input.emailSubject}`);
  if (input.emailDate) originLines.push(`📧 Received: ${input.emailDate}`);
  if (originLines.length > 0) sections.push(originLines.join('\n'));

  // Attendees
  if (input.organizer) {
    const attendeeLines = [`👤 Organizer: ${input.organizer}`];
    if (input.attendees && input.attendees.length > 0) {
      attendeeLines.push(`👥 Attendees: ${input.attendees.join(', ')}`);
    }
    sections.push(attendeeLines.join('\n'));
  } else if (input.attendees && input.attendees.length > 0) {
    sections.push(`👥 Attendees: ${input.attendees.join(', ')}`);
  }

  // Conference / meeting details
  const confLines: string[] = [];
  if (input.meetingUrl) {
    const label = input.meetingUrlLabel ?? input.conferenceProvider ?? 'Meeting Link';
    confLines.push(`🎥 ${label}: ${input.meetingUrl}`);
  }
  if (input.dialIn) confLines.push(`📞 Dial-in: ${input.dialIn}`);
  if (input.meetingId) {
    const idLine = input.passcode
      ? `🔑 Meeting ID: ${input.meetingId} · Passcode: ${input.passcode}`
      : `🔑 Meeting ID: ${input.meetingId}`;
    confLines.push(idLine);
  } else if (input.passcode) {
    confLines.push(`🔑 Passcode: ${input.passcode}`);
  }
  if (confLines.length > 0) sections.push(confLines.join('\n'));

  // Body excerpt
  if (input.bodyExcerpt) {
    const cleaned = input.bodyExcerpt.includes('<')
      ? stripHtml(input.bodyExcerpt)
      : input.bodyExcerpt;
    const excerpt = cleaned.slice(0, 500).trim();
    if (excerpt) sections.push(`📝 Details:\n${excerpt}${cleaned.length > 500 ? '…' : ''}`);
  }

  // Saved attachments (with file:// links)
  if (input.savedAttachments && input.savedAttachments.length > 0) {
    const lines = ['📎 Attachments:'];
    input.savedAttachments.forEach(({ filename, fileUrl, size }) => {
      lines.push(`  • ${filename} (${formatSize(size)}) → ${fileUrl}`);
    });
    sections.push(lines.join('\n'));
  } else if (input.pendingAttachments && input.pendingAttachments.length > 0) {
    // Fallback: list without paths (pre-save)
    const lines = ['📎 Attachments:'];
    input.pendingAttachments.forEach(({ filename, size }) => {
      lines.push(`  • ${filename} (${formatSize(size)})`);
    });
    sections.push(lines.join('\n'));
  }

  return sections.join('\n\n');
}
