import { extractMeetingUrl } from './meeting-url.js';

describe('extractMeetingUrl', () => {
  it('extracts Zoom URL', () => {
    const text = 'Join: https://us04web.zoom.us/j/123456?pwd=abc';
    const result = extractMeetingUrl(text);
    expect(result).toBeDefined();
    expect(result!.url).toBe('https://us04web.zoom.us/j/123456?pwd=abc');
    expect(result!.label).toBe('Zoom');
  });

  it('extracts Google Meet URL', () => {
    const text = 'Meeting at https://meet.google.com/abc-defg-hij';
    const result = extractMeetingUrl(text);
    expect(result).toBeDefined();
    expect(result!.url).toBe('https://meet.google.com/abc-defg-hij');
    expect(result!.label).toBe('Google Meet');
  });

  it('extracts Teams URL', () => {
    const text =
      'Join here: https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc/0?context=%7b%7d';
    const result = extractMeetingUrl(text);
    expect(result).toBeDefined();
    expect(result!.url).toContain('teams.microsoft.com/l/meetup-join');
    expect(result!.label).toBe('Microsoft Teams');
  });

  it('extracts Webex URL', () => {
    const text = 'Webex link: https://example.webex.com/meet/user';
    const result = extractMeetingUrl(text);
    expect(result).toBeDefined();
    expect(result!.url).toBe('https://example.webex.com/meet/user');
    expect(result!.label).toBe('Webex');
  });

  it('returns undefined for text with no meeting URL', () => {
    expect(extractMeetingUrl('Just a regular email about lunch.')).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(extractMeetingUrl('')).toBeUndefined();
  });

  it('strips trailing punctuation from URLs', () => {
    const text = 'Click here: https://meet.google.com/abc-defg-hij).';
    const result = extractMeetingUrl(text);
    expect(result).toBeDefined();
    expect(result!.url).toBe('https://meet.google.com/abc-defg-hij');
  });
});
