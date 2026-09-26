import { stripReplyChain } from './reply-chain.js';

describe('stripReplyChain', () => {
  it('drops quoted lines beginning with >', () => {
    const text = 'Thanks!\n> On Monday you wrote:\n> the original code was 111222';
    expect(stripReplyChain(text)).toBe('Thanks!');
  });

  it('cuts everything after a "-- " signature delimiter', () => {
    const text = 'See you\n-- \nJane Doe\nACME Corp';
    expect(stripReplyChain(text)).toBe('See you');
  });

  it('cuts everything after an ___ underscore delimiter', () => {
    const text = 'Reply above\n____\nFrom: someone';
    expect(stripReplyChain(text)).toBe('Reply above');
  });

  it('collapses runs of blank lines left behind by removed quotes', () => {
    const text = 'Hello\n\n\n\n> quoted\n\nBye';
    expect(stripReplyChain(text)).toBe('Hello\n\nBye');
  });

  it('returns unquoted text unchanged', () => {
    expect(stripReplyChain('Just a plain line')).toBe('Just a plain line');
  });
});
