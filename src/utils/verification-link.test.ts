import { extractMagicLink } from './verification-link.js';

describe('extractMagicLink', () => {
  describe('HTML anchors', () => {
    it('picks the verify CTA and ignores the unsubscribe decoy', () => {
      const bodyHtml = [
        '<p>Confirm your address:</p>',
        '<a href="https://example.com/verify?token=a1B2c3D4e5F6g7H8i9J0k1L2">Verify email</a>',
        '<a href="https://example.com/unsubscribe?u=42">Unsubscribe</a>',
      ].join('\n');
      const hit = extractMagicLink({ bodyHtml, senderAddress: 'no-reply@example.com' });
      expect(hit?.link).toBe('https://example.com/verify?token=a1B2c3D4e5F6g7H8i9J0k1L2');
      expect(hit?.anchorText).toBe('Verify email');
    });

    it('accepts a German CTA with an opaque token', () => {
      const bodyHtml =
        '<a href="https://service.de/x?t=Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2">Konto bestätigen</a>';
      const hit = extractMagicLink({ bodyHtml, senderAddress: 'mail@service.de' });
      expect(hit?.link).toBe('https://service.de/x?t=Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2');
    });

    it('prefers the sender-affiliated link over a tracker redirect', () => {
      const bodyHtml = [
        '<a href="https://links.tracker.net/ls/click?upn=Qq1Ww2Ee3Rr4Tt5Yy6Uu7Ii8">Sign in</a>',
        '<a href="https://app.myapp.io/signin/Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8">Sign in</a>',
      ].join('');
      const hit = extractMagicLink({ bodyHtml, senderAddress: 'hello@myapp.io' });
      expect(hit?.link).toBe('https://app.myapp.io/signin/Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8');
    });

    it('returns undefined for a footer-only newsletter', () => {
      const bodyHtml = [
        '<a href="https://newsletter.example.com/unsubscribe">Unsubscribe</a>',
        '<a href="https://example.com/privacy">Privacy policy</a>',
        '<a href="https://www.facebook.com/examplecorp">Facebook</a>',
        '<a href="https://example.com/blog/2026-roundup">Read more</a>',
      ].join('\n');
      expect(extractMagicLink({ bodyHtml, senderAddress: 'news@example.com' })).toBeUndefined();
    });

    it('rejects mailto and tel pseudo-links', () => {
      const bodyHtml =
        '<a href="mailto:login@example.com">login@example.com</a>' +
        '<a href="tel:+15554829137">Call us</a>';
      expect(extractMagicLink({ bodyHtml, senderAddress: 'x@example.com' })).toBeUndefined();
    });
  });

  describe('plain text', () => {
    it('extracts a bare sign-in URL and trims trailing punctuation', () => {
      const bodyText =
        'Click to sign in: https://example.com/auth/magic?code=Mm1Nn2Oo3Pp4Qq5Rr6Ss7Tt8.';
      const hit = extractMagicLink({ bodyText, senderAddress: 'auth@example.com' });
      expect(hit?.link).toBe('https://example.com/auth/magic?code=Mm1Nn2Oo3Pp4Qq5Rr6Ss7Tt8');
      expect(hit?.source).toBe('text');
    });

    it('ignores ordinary URLs without auth signals', () => {
      const bodyText = 'Read our latest post at https://example.com/blog/hello-world';
      expect(extractMagicLink({ bodyText, senderAddress: 'news@other.org' })).toBeUndefined();
    });
  });

  it('returns undefined when there is nothing to scan', () => {
    expect(extractMagicLink({ senderAddress: 'a@b.c' })).toBeUndefined();
  });
});
