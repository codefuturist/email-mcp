/**
 * Shared zod schema for the `attachments` parameter accepted by the
 * send_email, reply_email, forward_email, and save_draft tools.
 */

import { z } from 'zod';
import { MAX_ATTACHMENTS } from '../safety/validation.js';

const attachmentsSchema = z
  .array(
    z.object({
      filename: z.string().describe('File name shown to the recipient, e.g. "invoice.pdf"'),
      content: z
        .string()
        .optional()
        .describe('Base64-encoded file content. Provide this or `path`, not both.'),
      path: z
        .string()
        .optional()
        .describe('Absolute local file path to attach. Provide this or `content`, not both.'),
      contentType: z
        .string()
        .optional()
        .describe('MIME type, e.g. "application/pdf". Guessed from the filename if omitted.'),
    }),
  )
  .max(MAX_ATTACHMENTS)
  .optional()
  .describe('Files to attach (max 25MB each, 40MB total). Each item needs `content` or `path`.');

export default attachmentsSchema;
