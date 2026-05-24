// FakeMailer — in-memory Mailer fake (Phase 1.5 / task 4.11.1).
//
// Captures every outbound message in a public `sent` array. Tests assert
// directly against the array; nothing is delivered.

import type {
  Mailer,
  MailerInput,
} from '../../domain/notification/ports/Mailer.js';

export class FakeMailer implements Mailer {
  /** Public for direct assertion in tests. */
  readonly sent: MailerInput[] = [];

  async send(input: MailerInput): Promise<void> {
    // Defensive copy keeps the captured record stable even if the caller
    // mutates the original input afterwards.
    this.sent.push({ to: input.to, subject: input.subject, body: input.body });
  }

  /** Convenience: drop everything captured so far. */
  clear(): void {
    this.sent.length = 0;
  }
}
