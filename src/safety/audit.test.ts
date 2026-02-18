import fs from 'node:fs/promises';
import audit from './audit.js';

vi.mock('node:fs/promises');
const mockFs = vi.mocked(fs);

describe('Audit Logger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.appendFile.mockResolvedValue(undefined);
  });

  it('logs an entry with tool, account, and result', async () => {
    await audit.log('send_email', 'personal', { to: ['a@b.com'] }, 'ok');
    expect(mockFs.appendFile).toHaveBeenCalledOnce();
    const logLine = mockFs.appendFile.mock.calls[0][1] as string;
    const entry = JSON.parse(logLine);
    expect(entry.tool).toBe('send_email');
    expect(entry.account).toBe('personal');
    expect(entry.result).toBe('ok');
    expect(entry.params.to).toEqual(['a@b.com']);
  });

  it('redacts password field', async () => {
    await audit.log('send_email', 'x', { password: 'secret123', to: ['a@b.com'] }, 'ok');
    const logLine = mockFs.appendFile.mock.calls[0][1] as string;
    const entry = JSON.parse(logLine);
    expect(entry.params.password).toBe('[REDACTED]');
    expect(entry.params.to).toEqual(['a@b.com']);
  });

  it('redacts body, bodyText, bodyHtml, content_base64', async () => {
    await audit.log(
      'send_email',
      'x',
      {
        body: 'secret body',
        bodyText: 'text',
        bodyHtml: '<p>html</p>',
        content_base64: 'base64data',
        subject: 'visible',
      },
      'ok',
    );
    const logLine = mockFs.appendFile.mock.calls[0][1] as string;
    const entry = JSON.parse(logLine);
    expect(entry.params.body).toBe('[REDACTED]');
    expect(entry.params.bodyText).toBe('[REDACTED]');
    expect(entry.params.bodyHtml).toBe('[REDACTED]');
    expect(entry.params.content_base64).toBe('[REDACTED]');
    expect(entry.params.subject).toBe('visible');
  });

  it('redacts nested sensitive fields', async () => {
    await audit.log('test', 'x', { nested: { password: 'abc', safe: 'ok' } }, 'ok');
    const logLine = mockFs.appendFile.mock.calls[0][1] as string;
    const entry = JSON.parse(logLine);
    expect(entry.params.nested.password).toBe('[REDACTED]');
    expect(entry.params.nested.safe).toBe('ok');
  });

  it('includes error field when provided', async () => {
    await audit.log('send_email', 'x', {}, 'error', 'Connection failed');
    const logLine = mockFs.appendFile.mock.calls[0][1] as string;
    const entry = JSON.parse(logLine);
    expect(entry.result).toBe('error');
    expect(entry.error).toBe('Connection failed');
  });

  it('does not include error field when not provided', async () => {
    await audit.log('send_email', 'x', {}, 'ok');
    const logLine = mockFs.appendFile.mock.calls[0][1] as string;
    const entry = JSON.parse(logLine);
    expect(entry.error).toBeUndefined();
  });

  it('creates directory before writing', async () => {
    await audit.log('test', 'x', {}, 'ok');
    expect(mockFs.mkdir).toHaveBeenCalledBefore(mockFs.appendFile);
  });
});
