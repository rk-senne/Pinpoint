// Mailer outbound port (Phase 1.5 / task 4.6.2).
//
// The SMTP adapter is the only file in the codebase that imports
// `nodemailer`. Templates are owned by the domain layer
// (`renderTemplate(payload)`); the adapter only knows how to send the
// rendered subject + body to a destination address.

export interface MailerInput {
  to: string;
  subject: string;
  body: string;
}

export interface Mailer {
  send(input: MailerInput): Promise<void>;
}
