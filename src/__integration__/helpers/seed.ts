import nodemailer from 'nodemailer';
import { getGreenMailPorts } from './config.js';

interface SeedEmailOptions {
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  html?: string;
  cc?: string[];
  bcc?: string[];
  inReplyTo?: string;
  references?: string[];
  attachments?: {
    filename: string;
    content: string | Buffer;
    contentType?: string;
  }[];
}

function createTransport(user = 'test') {
  const { host, smtpPort } = getGreenMailPorts();
  return nodemailer.createTransport({
    host,
    port: smtpPort,
    secure: false,
    auth: { user, pass: user },
    tls: { rejectUnauthorized: false },
  });
}

export async function seedEmail(options: SeedEmailOptions = {}) {
  const from = options.from ?? 'sender@localhost';
  const user = from.split('@')[0];
  const transport = createTransport(user);
  try {
    const info = await transport.sendMail({
      from,
      to: options.to ?? 'test@localhost',
      subject: options.subject ?? 'Test Email',
      text: options.text ?? 'Hello from integration tests',
      html: options.html,
      cc: options.cc?.join(', '),
      bcc: options.bcc?.join(', '),
      inReplyTo: options.inReplyTo,
      references: options.references?.join(' '),
      attachments: options.attachments,
    });
    return info.messageId;
  } finally {
    transport.close();
  }
}

export async function seedEmails(count: number, options: SeedEmailOptions = {}) {
  const messageIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const messageId = await seedEmail({
      ...options,
      subject: options.subject ?? `Test Email ${i + 1}`,
    });
    messageIds.push(messageId);
  }
  return messageIds;
}

export async function seedThread(length: number, options: SeedEmailOptions = {}) {
  const messageIds: string[] = [];
  const allRefs: string[] = [];

  for (let i = 0; i < length; i++) {
    const from = i % 2 === 0 ? 'alice@localhost' : 'test@localhost';
    const to = i % 2 === 0 ? 'test@localhost' : 'alice@localhost';

    const messageId = await seedEmail({
      from,
      to,
      subject:
        i === 0
          ? (options.subject ?? 'Thread Subject')
          : `Re: ${options.subject ?? 'Thread Subject'}`,
      text: `Message ${i + 1} in thread`,
      inReplyTo: messageIds[i - 1],
      references: allRefs.length > 0 ? [...allRefs] : undefined,
    });

    messageIds.push(messageId);
    allRefs.push(messageId);
  }

  return messageIds;
}

export async function seedEmailWithAttachment(
  filename = 'test.txt',
  content = 'attachment content',
  options: SeedEmailOptions = {},
) {
  return seedEmail({
    ...options,
    subject: options.subject ?? 'Email with attachment',
    attachments: [{ filename, content, contentType: 'text/plain' }],
  });
}

// Small delay to let GreenMail process emails
export async function waitForDelivery(ms = 500): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
