import { globToRegex, matchesPattern } from './glob.js';

describe('globToRegex', () => {
  it('translates * into a greedy wildcard', () => {
    expect(globToRegex('*@example.com').test('ci@example.com')).toBe(true);
  });

  it('anchors the pattern to the full value', () => {
    expect(globToRegex('example').test('my-example-value')).toBe(false);
  });
});

describe('matchesPattern', () => {
  it('matches case-insensitively', () => {
    expect(matchesPattern('ci@example.com', 'CI@EXAMPLE.COM')).toBe(true);
  });

  it('treats | as OR between alternatives', () => {
    expect(matchesPattern('a@x.com | b@y.com', 'b@y.com')).toBe(true);
    expect(matchesPattern('a@x.com | b@y.com', 'c@z.com')).toBe(false);
  });

  it('escapes regex metacharacters in the pattern', () => {
    expect(matchesPattern('a+b@x.com', 'a+b@x.com')).toBe(true);
    expect(matchesPattern('a+b@x.com', 'aab@x.com')).toBe(false);
  });

  it('returns false for an empty pattern', () => {
    expect(matchesPattern('', 'anything')).toBe(false);
  });
});
