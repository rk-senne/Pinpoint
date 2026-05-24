// NodemailerMailer — outbound adapter for the `Mailer` port
// (Phase 1.5 / task 4.8.3).
//
// This file is the **only** place in the codebase allowed to import
// `nodemailer`. Domain code depends exclusively on the `Mailer`
// interface declared under `domain/notification/ports/Mailer.ts`.
//
// The adapter is intentionally a thin wrapper: templating (subject + body
// rendering) is owned by the domain layer's `renderTemplate(payload)`
// helper, and recipient preference gating happens upstream in the use
// case. By the time `send` is called the message is fully rendered and
// approved for delivery; the adapter only knows how to hand it to the
// transport.

import type { Transporter } from 'nodemailer';
import type {
  Mailer,
  MailerInput,
} from '../../../domain/notification/ports/Mailer.js';

export interface NodemailerMailerConfig {
  /**
   * RFC 5322 `From:` address used for every outgoing message. The
   * composition root reads this from configuration; the adapter never
   * touches `process.env` directly.
   */
  fromAddress: string;
}

export class NodemailerMailer implements Mailer {
  constructor(
    private readonly transporter: Transporter,
    private readonly config: NodemailerMailerConfig,
  ) {}

  async send(input: MailerInput): Promise<void> {
    await this.transporter.sendMail({
      from: this.config.fromAddress,
      to: input.to,
      subject: input.subject,
      // The `Mailer` port carries a single `body` field (plain text). The
      // domain templates render simple notification messages, so we send
      // them as text. If a future template needs HTML the port will need
      // an explicit `html` field; we deliberately do not infer "is this
      // HTML?" from the body string here.
      text: input.body,
    });
  }
}
