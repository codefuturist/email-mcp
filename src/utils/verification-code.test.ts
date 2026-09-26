import { extractVerificationCode } from './verification-code.js';

describe('extractVerificationCode', () => {
  describe('English positives', () => {
    it('finds a code in the subject line', () => {
      const hit = extractVerificationCode('482913 is your GitHub authentication code', '');
      expect(hit?.code).toBe('482913');
      expect(hit?.source).toBe('subject');
      expect(hit?.confidence).toBe('high');
    });

    it('finds a code next to expiry wording in the body', () => {
      const hit = extractVerificationCode(
        'Verify your email',
        'Your verification code is 482913. It expires in 10 minutes.',
      );
      expect(hit?.code).toBe('482913');
      expect(hit?.confidence).toBe('high');
    });

    it('accepts a 5-digit code with sign-in context', () => {
      const hit = extractVerificationCode('', 'Use code 48291 to sign in to your account.');
      expect(hit?.code).toBe('48291');
    });

    it('joins space-separated groups (Apple style) into one code', () => {
      const hit = extractVerificationCode('', 'Your code is: 123 456');
      expect(hit?.code).toBe('123456');
      expect(hit?.display).toBe('123 456');
    });

    it('canonicalizes the Google G- prefix to digits only', () => {
      const hit = extractVerificationCode('', 'G-482913 is your Google verification code.');
      expect(hit?.code).toBe('482913');
      expect(hit?.display).toBe('G-482913');
    });

    it('keeps non-Google prefixes as part of the code', () => {
      const hit = extractVerificationCode('', 'Your verification code: FB-48291');
      expect(hit?.code).toBe('FB-48291');
    });

    it('accepts an alphanumeric one-time passcode', () => {
      const hit = extractVerificationCode('', 'Your one-time passcode: 7K3M9Q');
      expect(hit?.code).toBe('7K3M9Q');
    });

    it('finds a code alone on its own line below the prompt', () => {
      const hit = extractVerificationCode(
        '',
        'Enter this code:\n\n482913\n\nThe code expires soon.',
      );
      expect(hit?.code).toBe('482913');
    });

    it('accepts an 8-digit security code', () => {
      const hit = extractVerificationCode('', 'Your Microsoft account security code is 48291037');
      expect(hit?.code).toBe('48291037');
    });
  });

  describe('German positives', () => {
    it('finds a Bestätigungscode', () => {
      const hit = extractVerificationCode('', 'Ihr Bestätigungscode lautet 348290');
      expect(hit?.code).toBe('348290');
    });

    it('joins a space-separated Sicherheitscode', () => {
      const hit = extractVerificationCode('', 'Ihr Sicherheitscode: 903 224');
      expect(hit?.code).toBe('903224');
    });

    it('finds an Einmalpasswort with validity window', () => {
      const hit = extractVerificationCode('', 'Einmalpasswort: 552901 (gültig für 10 Minuten)');
      expect(hit?.code).toBe('552901');
      expect(hit?.confidence).toBe('high');
    });

    it('finds a code in a German subject with empty body', () => {
      const hit = extractVerificationCode('348290 ist Ihr Amazon-Sicherheitscode', '');
      expect(hit?.code).toBe('348290');
      expect(hit?.source).toBe('subject');
    });
  });

  describe('false positives return undefined', () => {
    it('ignores order numbers and tracking numbers', () => {
      const hit = extractVerificationCode(
        'Your order #482913 has shipped',
        'Track your order 482913 with tracking number 1Z999AA10123456784.',
      );
      expect(hit).toBeUndefined();
    });

    it('ignores invoice numbers next to amounts', () => {
      const hit = extractVerificationCode('', 'Rechnung Nr. 482913 — Betrag: CHF 129.90');
      expect(hit).toBeUndefined();
    });

    it('ignores parcel tracking (Sendungsnummer)', () => {
      const hit = extractVerificationCode(
        'Ihre Sendung ist unterwegs',
        'Sendungsnummer 00340434161094. Zur Sendungsverfolgung klicken Sie hier.',
      );
      expect(hit).toBeUndefined();
    });

    it('ignores phone numbers', () => {
      const hit = extractVerificationCode('', 'Questions? Call 555 482 9137 any time.');
      expect(hit).toBeUndefined();
    });

    it('ignores ticket numbers and dates', () => {
      const hit = extractVerificationCode('', 'Ticket 482913 opened on 12.03.2026');
      expect(hit).toBeUndefined();
    });

    it('ignores a Zoom invite passcode (conference, not auth)', () => {
      const body = [
        'Jane invites you to a Zoom meeting.',
        'Join: https://zoom.us/j/93422110000',
        'Meeting-ID: 934 2211 0000',
        'Passcode: 482913',
      ].join('\n');
      expect(extractVerificationCode('Zoom meeting invitation', body)).toBeUndefined();
    });

    it('ignores years, prices, and street numbers in newsletters', () => {
      const body =
        'Sale! Save 20% until 2026.\nPrices from EUR 49.99.\nVisit us at Hauptstrasse 15, 8004 Zürich.';
      expect(extractVerificationCode('Autumn sale', body)).toBeUndefined();
    });

    it('ignores a keyword-less number', () => {
      expect(extractVerificationCode('', 'The parcel weighs 482913 grams.')).toBeUndefined();
    });

    it('returns undefined for empty input', () => {
      expect(extractVerificationCode('', '')).toBeUndefined();
    });
  });

  describe('prioritization', () => {
    it('picks the keyword-adjacent code over an order number in the same mail', () => {
      const body = 'Order 55123 confirmed.\n\nYour verification code is 482913.';
      const hit = extractVerificationCode('Order confirmation', body);
      expect(hit?.code).toBe('482913');
    });

    it('ignores stale codes inside quoted reply chains when caller pre-strips them', () => {
      // stripReplyChain is the caller's job; this documents the contract:
      // the extractor itself sees only the stripped text.
      const body = 'Your verification code is 482913.';
      const hit = extractVerificationCode('', body);
      expect(hit?.evidence).toContain('482913');
    });
  });
});
