import type { EmailMessage, EmailSender, EmailSendResult } from './contract.js';

/** Development/test driver: records messages in memory and optionally logs a one-line summary. Never sends. */
export class LogEmailSender implements EmailSender {
  readonly driver = 'log' as const;
  readonly delivers = false;
  readonly sent: EmailMessage[] = [];

  constructor(
    readonly from: string,
    private readonly log: ((line: string) => void) | null = null,
  ) {}

  async send(message: EmailMessage): Promise<EmailSendResult> {
    this.sent.push(message);
    this.log?.(`email (log driver) to=${[message.to].flat().join(',')} subject="${message.subject}"`);
    return { id: null };
  }
}
