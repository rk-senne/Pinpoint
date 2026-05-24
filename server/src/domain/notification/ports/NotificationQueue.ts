// NotificationQueue outbound port (Phase 1.5 / task 4.6.2).
//
// Implementation is the Postgres adapter's `SELECT … FOR UPDATE SKIP
// LOCKED` polling loop. The domain layer only knows about the operations
// described here.

import type {
  Notification,
  NotificationPayload,
} from '../Notification.js';

export interface NotificationQueue {
  /** Insert a new pending row scheduled for `scheduledAt`. */
  enqueue(payload: NotificationPayload, scheduledAt: Date): Promise<string>;

  /**
   * Claim up to `limit` due rows for dispatch. Implementations should hold
   * a `FOR UPDATE SKIP LOCKED` lock on the rows until the dispatch result
   * is recorded (i.e., until `markSent` / `markPending` / `markFailed`
   * runs in the same transaction). For tests / simpler adapters, returning
   * a snapshot is acceptable.
   */
  claimDue(limit: number, now: Date): Promise<Notification[]>;

  /** Transition to `sent`. */
  markSent(id: string): Promise<void>;

  /** Transition back to `pending` with bumped attempts + new schedule. */
  markPending(
    id: string,
    attempts: number,
    scheduledAt: Date,
    lastError: string,
  ): Promise<void>;

  /** Transition to `failed` after exhausting retries. */
  markFailed(id: string, attempts: number, lastError: string): Promise<void>;
}
