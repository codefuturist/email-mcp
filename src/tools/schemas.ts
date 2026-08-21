/**
 * Shared Zod output schemas for structured tool results (MCP 2026-07-28).
 *
 * Tools that return enumerable / queryable data declare an `outputSchema` and
 * return `structuredContent` alongside the human-readable `content` text, so
 * clients can consume the data programmatically. These schemas mirror the
 * corresponding domain types in `../types/index.ts`.
 */

import { z } from 'zod';

/** Mirrors `EmailAddress`. */
export const emailAddressSchema = z.object({
  name: z.string().optional(),
  address: z.string(),
});

/** Mirrors `EmailMeta` (the list/search row). */
export const emailMetaSchema = z.object({
  id: z.string(),
  subject: z.string(),
  from: emailAddressSchema,
  to: z.array(emailAddressSchema),
  date: z.string(),
  seen: z.boolean(),
  flagged: z.boolean(),
  answered: z.boolean(),
  hasAttachments: z.boolean(),
  labels: z.array(z.string()),
  preview: z.string().optional(),
});

/** Structured result for `list_emails` / `search_emails`. */
export const emailListOutputSchema = z.object({
  account: z.string(),
  mailbox: z.string(),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  hasMore: z.boolean(),
  count: z.number().int(),
  emails: z.array(emailMetaSchema),
});

/** Mirrors `Mailbox`. */
export const mailboxSchema = z.object({
  name: z.string(),
  path: z.string(),
  specialUse: z.string().optional(),
  totalMessages: z.number().int().optional(),
  unseenMessages: z.number().int().optional(),
});

/** Structured result for `list_mailboxes`. */
export const mailboxListOutputSchema = z.object({
  account: z.string(),
  count: z.number().int(),
  mailboxes: z.array(mailboxSchema),
});

/** Structured result for `get_email_status`. */
export const emailStatusOutputSchema = z.object({
  id: z.string(),
  mailbox: z.string(),
  subject: z.string(),
  from: z.string(),
  date: z.string(),
  seen: z.boolean(),
  flagged: z.boolean(),
  answered: z.boolean(),
  labels: z.array(z.string()),
});
