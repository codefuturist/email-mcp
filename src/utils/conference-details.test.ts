import { extractConferenceDetails } from './conference-details.js';

describe('extractConferenceDetails', () => {
  it('extracts meeting ID', () => {
    const text = 'Meeting ID: 123 456 789';
    const result = extractConferenceDetails(text);
    expect(result).toBeDefined();
    expect(result!.meetingId).toBe('123 456 789');
  });

  it('extracts passcode', () => {
    const text = 'Passcode: 123456';
    const result = extractConferenceDetails(text);
    expect(result).toBeDefined();
    expect(result!.passcode).toBe('123456');
  });

  it('extracts dial-in number', () => {
    const text = 'Dial-in: +1 (555) 123-4567';
    const result = extractConferenceDetails(text);
    expect(result).toBeDefined();
    expect(result!.dialIn).toBeDefined();
    expect(result!.dialIn).toMatch(/555/);
  });

  it('detects Zoom provider from zoom.us in text', () => {
    const text = 'Join at https://us04web.zoom.us/j/123 Meeting ID: 123 456 789';
    const result = extractConferenceDetails(text);
    expect(result).toBeDefined();
    expect(result!.provider).toBe('Zoom');
  });

  it('detects Teams provider from teams.microsoft.com', () => {
    const text = 'Join at https://teams.microsoft.com/l/meetup-join/abc Meeting ID: 123 456 789';
    const result = extractConferenceDetails(text);
    expect(result).toBeDefined();
    expect(result!.provider).toBe('Microsoft Teams');
  });

  it('returns undefined for text with no conference details', () => {
    expect(extractConferenceDetails('Just a regular email.')).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(extractConferenceDetails('')).toBeUndefined();
  });
});
