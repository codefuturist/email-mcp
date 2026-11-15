/**
 * Sender identities — the addresses an account may send as.
 *
 * Every account has one implicit identity (its own `email`/`full_name`/
 * `sent_mailbox`). `[[accounts.identities]]` adds aliases the provider lets
 * the same login send from. Only configured identities can ever end up in
 * From: — a caller asking for any other address gets an error, not a
 * spoofed header.
 *
 * Pure functions, no I/O — unit-testable without connections.
 */

import type { AccountConfig, Email, EmailAddress, SenderIdentity } from '../types/index.js';

const normalize = (address: string): string => address.trim().toLowerCase();

/** The account's primary identity, built from its top-level fields. */
export function primaryIdentity(account: AccountConfig): SenderIdentity {
  return {
    email: account.email,
    ...(account.fullName ? { fullName: account.fullName } : {}),
    ...(account.sentMailbox ? { sentMailbox: account.sentMailbox } : {}),
  };
}

/**
 * All identities of an account, primary first. An alias that repeats the
 * primary address (in any case) is dropped, as is a repeated alias — the
 * first entry wins.
 */
export function listIdentities(account: AccountConfig): SenderIdentity[] {
  const seen = new Set<string>();
  const result: SenderIdentity[] = [];
  for (const identity of [primaryIdentity(account), ...(account.identities ?? [])]) {
    const key = normalize(identity.email);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(identity);
    }
  }
  return result;
}

/** The configured identity for `address`, or undefined. Case-insensitive. */
export function findIdentity(
  account: AccountConfig,
  address: string | undefined,
): SenderIdentity | undefined {
  if (!address) return undefined;
  const key = normalize(address);
  return listIdentities(account).find((identity) => normalize(identity.email) === key);
}

/** Whether `address` is one of this account's own addresses. */
export function isOwnAddress(account: AccountConfig, address: string): boolean {
  return findIdentity(account, address) !== undefined;
}

/**
 * Resolve a caller-supplied `from` to a configured identity.
 *
 * Omitted → the primary identity. Anything not configured is rejected,
 * naming the addresses that are allowed so the caller can correct itself.
 */
export function resolveIdentity(account: AccountConfig, from: string | undefined): SenderIdentity {
  if (from === undefined || from.trim() === '') return primaryIdentity(account);
  const identity = findIdentity(account, from);
  if (!identity) {
    const allowed = listIdentities(account)
      .map((i) => i.email)
      .join(', ');
    throw new Error(
      `"${from}" is not a sender identity of account "${account.name}". ` +
        `Allowed: ${allowed}. Add it under [[accounts.identities]] to send as it.`,
    );
  }
  return identity;
}

/** Envelope-style headers that name the address a message was delivered to. */
const DELIVERY_HEADERS = ['x-original-to', 'delivered-to', 'x-envelope-to'] as const;

/** Pull bare addresses out of a header value such as `"A" <a@x>, b@y`. */
function addressesInHeader(value: string | undefined): string[] {
  if (!value) return [];
  return value.match(/[^\s<>,;"']+@[^\s<>,;"']+/g) ?? [];
}

/**
 * The identity a reply should go out from: the one the original was
 * addressed to, else the primary identity.
 *
 * Follows Thunderbird for Android / K-9 Mail (`IdentityHelper.
 * getRecipientIdentityFromMessage`): check To, then Cc, then the delivery
 * headers X-Original-To, Delivered-To and X-Envelope-To, and take the first
 * address that matches an identity. The delivery headers catch mail that
 * reached an alias via Bcc or a mailing list.
 */
export function identityForReply(account: AccountConfig, original: Email): SenderIdentity {
  const candidates: string[] = [
    ...original.to.map((a: EmailAddress) => a.address),
    ...(original.cc ?? []).map((a: EmailAddress) => a.address),
    ...DELIVERY_HEADERS.flatMap((name) => addressesInHeader(original.headers?.[name])),
  ];
  for (const address of candidates) {
    const identity = findIdentity(account, address);
    if (identity) return identity;
  }
  return primaryIdentity(account);
}

/** The From: value for nodemailer — `"Name" <addr>` or the bare address. */
export function formatSender(identity: SenderIdentity): string {
  return identity.fullName ? `"${identity.fullName}" <${identity.email}>` : identity.email;
}
