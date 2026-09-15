import {
  extractAttachments,
  findMimePartByFilename,
  hasAttachments,
} from './mime-attachments.js';

describe('mime-attachments', () => {
  const inlineCidInbox = {
    type: 'multipart/mixed',
    childNodes: [
      {
        type: 'multipart/alternative',
        childNodes: [{ type: 'text/plain' }, { type: 'text/html' }],
      },
      {
        type: 'image/png',
        parameters: { name: 'image025.png' },
        id: '<image025.png@01DD403F.511179C0>',
        size: 100,
        part: '2',
      },
      {
        type: 'image/png',
        parameters: { name: 'image026.png' },
        id: '<image026.png@01DD403F.511179C0>',
        size: 200,
        part: '3',
      },
    ],
  };

  const duplicateNames = {
    type: 'multipart/related',
    childNodes: [
      { type: 'text/html' },
      {
        type: 'image/png',
        parameters: { name: 'image.png' },
        id: '<cid-a>',
        size: 5500,
        part: '2',
      },
      {
        type: 'image/png',
        parameters: { name: 'image.png' },
        id: '<cid-b>',
        size: 7800,
        part: '3',
      },
    ],
  };

  it('lists inline CID images with full MIME type and no Content-Disposition', () => {
    const attachments = extractAttachments(outlookInbox);
    expect(attachments.map((a) => a.filename)).toEqual(['image025.png', 'image026.png']);
    expect(attachments.every((a) => a.mimeType === 'image/png')).toBe(true);
    expect(hasAttachments(outlookInbox)).toBe(true);
    expect(findMimePartByFilename(outlookInbox, 'image025.png')).toBe('2');
    expect(findMimePartByFilename(outlookInbox, 'image026.png')).toBe('3');
  });

  it('uniquifies duplicate filenames and resolves by Content-ID', () => {
    const attachments = extractAttachments(duplicateNames);
    expect(attachments.map((a) => a.filename)).toEqual(['image.png', 'image-2.png']);
    expect(findMimePartByFilename(duplicateNames, 'image.png')).toBe('2');
    expect(findMimePartByFilename(duplicateNames, 'image-2.png')).toBe('3');
    expect(findMimePartByFilename(duplicateNames, 'cid-b')).toBe('3');
  });

  it('still finds classic Content-Disposition attachments', () => {
    const classic = {
      type: 'multipart/mixed',
      childNodes: [
        { type: 'text/plain' },
        {
          type: 'application',
          subtype: 'pdf',
          disposition: 'attachment',
          dispositionParameters: { filename: 'report.pdf' },
          size: 10,
          part: '2',
        },
      ],
    };
    expect(extractAttachments(classic)).toEqual([
      { filename: 'report.pdf', mimeType: 'application/pdf', size: 10 },
    ]);
    expect(findMimePartByFilename(classic, 'report.pdf')).toBe('2');
  });
});
