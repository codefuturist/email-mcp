import { buildCalendarNotes } from './calendar-notes.js';

describe('buildCalendarNotes', () => {
  it('includes email origin info', () => {
    const result = buildCalendarNotes({
      emailFrom: 'alice@example.com',
      emailSubject: 'Team Sync',
      emailDate: '2024-01-15',
    });
    expect(result).toContain('From: alice@example.com');
    expect(result).toContain('Subject: Team Sync');
    expect(result).toContain('Received: 2024-01-15');
  });

  it('includes organizer and attendees', () => {
    const result = buildCalendarNotes({
      organizer: 'alice@example.com',
      attendees: ['bob@example.com', 'charlie@example.com'],
    });
    expect(result).toContain('Organizer: alice@example.com');
    expect(result).toContain('Attendees: bob@example.com, charlie@example.com');
  });

  it('includes meeting URL with label', () => {
    const result = buildCalendarNotes({
      meetingUrl: 'https://meet.google.com/abc-defg-hij',
      meetingUrlLabel: 'Google Meet',
    });
    expect(result).toContain('Google Meet: https://meet.google.com/abc-defg-hij');
  });

  it('includes dial-in, meeting ID, and passcode', () => {
    const result = buildCalendarNotes({
      dialIn: '+1 555 123 4567',
      meetingId: '123 456 789',
      passcode: '999888',
    });
    expect(result).toContain('Dial-in: +1 555 123 4567');
    expect(result).toContain('Meeting ID: 123 456 789');
    expect(result).toContain('Passcode: 999888');
  });

  it('truncates body excerpt to 500 chars with ellipsis', () => {
    const longBody = 'a'.repeat(600);
    const result = buildCalendarNotes({ bodyExcerpt: longBody });
    expect(result).toContain('a'.repeat(500));
    expect(result).toContain('…');
  });

  it('strips HTML from body excerpt', () => {
    const result = buildCalendarNotes({
      bodyExcerpt: '<p>Hello <b>world</b></p>',
    });
    expect(result).toContain('Hello world');
    expect(result).not.toContain('<p>');
    expect(result).not.toContain('<b>');
  });

  it('formats attachment sizes correctly', () => {
    const result = buildCalendarNotes({
      savedAttachments: [
        { filename: 'small.txt', fileUrl: 'file:///tmp/small.txt', size: 500 },
        { filename: 'medium.pdf', fileUrl: 'file:///tmp/medium.pdf', size: 2048 },
        { filename: 'large.zip', fileUrl: 'file:///tmp/large.zip', size: 5 * 1024 * 1024 },
      ],
    });
    expect(result).toContain('500 B');
    expect(result).toContain('2 KB');
    expect(result).toContain('5.0 MB');
  });

  it('returns empty string for empty input', () => {
    expect(buildCalendarNotes({})).toBe('');
  });
});
