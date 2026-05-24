// Notification entity (Req 28 / Phase 1.5 task 4.6.1).
//
// Durable queue row shape. Producers `enqueue` rows with `status='pending'`;
// the dispatcher claims rows via `SELECT … FOR UPDATE SKIP LOCKED`,
// transitions them to `sent` on success or back to `pending` (with a
// backoff `scheduledAt`) / `failed` on failure.

export type NotificationStatus = 'pending' | 'sent' | 'failed';

export type NotificationKind =
  | 'annotation_created'
  | 'comment_created'
  | 'mention'
  | 'promoted_to_owner'
  | 'project_deleted'
  | 'verify_email';

/** Discriminated payload for a queued Notification (Req 28). */
export interface NotificationPayload {
  kind: NotificationKind;
  recipientUserId: string;
  [key: string]: unknown;
}

export interface Notification {
  id: string;
  status: NotificationStatus;
  attempts: number;
  payload: NotificationPayload;
  scheduledAt: string; // ISO 8601
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}
