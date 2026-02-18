/**
 * Tests for local-calendar.service helpers.
 */

import { describe, expect, it } from 'vitest';

import { dateToAppleScriptLines, escapeAS } from './local-calendar.service.js';

// ---------------------------------------------------------------------------
// escapeAS
// ---------------------------------------------------------------------------

describe('escapeAS', () => {
  it('escapes backslashes', () => {
    expect(escapeAS('a\\b')).toBe('a\\\\b');
  });

  it('escapes double quotes', () => {
    expect(escapeAS('say "hello"')).toBe('say \\"hello\\"');
  });

  it('handles both together', () => {
    expect(escapeAS('path\\to\\"file"')).toBe('path\\\\to\\\\\\"file\\"');
  });

  it('returns empty string unchanged', () => {
    expect(escapeAS('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// dateToAppleScriptLines
// ---------------------------------------------------------------------------

describe('dateToAppleScriptLines', () => {
  it('emits correct component-setting lines for a given date', () => {
    // Use a specific date — 19 Feb 2026 16:30:45 local time
    const d = new Date(2026, 1, 19, 16, 30, 45); // month is 0-indexed

    const lines = dateToAppleScriptLines('eventStart', d);

    expect(lines).toEqual([
      'set eventStart to current date',
      'set year of eventStart to 2026',
      'set month of eventStart to 2',
      'set day of eventStart to 19',
      'set hours of eventStart to 16',
      'set minutes of eventStart to 30',
      'set seconds of eventStart to 45',
    ]);
  });

  it('handles midnight correctly (all zeros for time)', () => {
    const d = new Date(2025, 0, 1, 0, 0, 0); // 1 Jan 2025 00:00:00

    const lines = dateToAppleScriptLines('eventEnd', d);

    expect(lines).toEqual([
      'set eventEnd to current date',
      'set year of eventEnd to 2025',
      'set month of eventEnd to 1',
      'set day of eventEnd to 1',
      'set hours of eventEnd to 0',
      'set minutes of eventEnd to 0',
      'set seconds of eventEnd to 0',
    ]);
  });

  it('handles end-of-year date', () => {
    const d = new Date(2024, 11, 31, 23, 59, 59); // 31 Dec 2024 23:59:59

    const lines = dateToAppleScriptLines('d', d);

    expect(lines).toEqual([
      'set d to current date',
      'set year of d to 2024',
      'set month of d to 12',
      'set day of d to 31',
      'set hours of d to 23',
      'set minutes of d to 59',
      'set seconds of d to 59',
    ]);
  });

  it('uses custom variable name', () => {
    const d = new Date(2026, 5, 15, 9, 0, 0);

    const lines = dateToAppleScriptLines('myDate', d);

    expect(lines[0]).toBe('set myDate to current date');
    expect(lines).toHaveLength(7);
    expect(lines.every((l) => l.includes('myDate'))).toBe(true);
  });

  it('uses local time, not UTC', () => {
    // Create a date from a UTC string — the local components should differ
    // from UTC if the test machine is not in UTC.
    // We just verify the function uses getFullYear/getHours (local), not
    // getUTCFullYear/getUTCHours.
    const d = new Date(2026, 1, 19, 16, 0, 0);
    const lines = dateToAppleScriptLines('ev', d);

    // The hour must match the local hour we set (16), regardless of UTC offset
    expect(lines).toContain('set hours of ev to 16');
  });
});
