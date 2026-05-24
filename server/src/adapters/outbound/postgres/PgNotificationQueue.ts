// Postgres adapter for NotificationQueue (Phase 1.5 / task 4.8.1).
//
// Backed by the `notifications` table created in migration
// 20240105000000_notifications_table. `claimDue` uses
// `SELECT ... FOR UPDATE SKIP LOCKED` so multiple worker instances can
// poll concurrently without double-sending the same row. The lock is
// held only inside the transaction the helper opens; callers that need
// the row to stay locked across `markSent`/`markPending`/`markFailed`
// must wrap the whole sequence in their own transaction.

import type { Knex } from 'knex';
import type {
  Notification,
  NotificationPayload,
  NotificationStatus,
} from '../../../domain/notification/Notification.js';
import type { NotificationQueue } from '../../../domain/notification/ports/NotificationQueue.js';

interface NotificationRow {
  id: string;
  status: string;
  attempts: number;
  payload: NotificationPayload | string;
  scheduled_at: Date | string;
  last_error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export class PgNotificationQueue implements NotificationQueue {
  constructor(private readonly db: Knex) {}

  async enqueue(payload: NotificationPayload, scheduledAt: Date): Promise<string> {
    const inserted = await this.db('notifications')
      .insert({
        status: 'pending',
        attempts: 0,
        payload,
        scheduled_at: scheduledAt,
      })
      .returning<Array<{ id: string }>>('id');

    const first = inserted[0] as { id: string } | string | undefined;
    if (!first) {
      throw new Error('PgNotificationQueue.enqueue: no id returned from insert');
    }
    return typeof first === 'string' ? first : first.id;
  }

  async claimDue(limit: number, now: Date): Promise<Notification[]> {
    return this.db.transaction(async (tx) => {
      const result = await tx.raw<{ rows: NotificationRow[] }>(
        `SELECT id, status, attempts, payload, scheduled_at, last_error, created_at, updated_at
           FROM notifications
          WHERE status = 'pending'
            AND scheduled_at <= ?
          ORDER BY scheduled_at
          LIMIT ?
          FOR UPDATE SKIP LOCKED`,
        [now, limit],
      );

      const rows: NotificationRow[] = Array.isArray(result)
        ? (result as unknown as NotificationRow[])
        : (result?.rows ?? []);
      return rows.map((r) => this.mapRow(r));
    });
  }

  async markSent(id: string): Promise<void> {
    await this.db('notifications').where({ id }).update({
      status: 'sent',
      updated_at: new Date(),
    });
  }

  async markPending(
    id: string,
    attempts: number,
    scheduledAt: Date,
    lastError: string,
  ): Promise<void> {
    await this.db('notifications').where({ id }).update({
      status: 'pending',
      attempts,
      scheduled_at: scheduledAt,
      last_error: lastError,
      updated_at: new Date(),
    });
  }

  async markFailed(id: string, attempts: number, lastError: string): Promise<void> {
    await this.db('notifications').where({ id }).update({
      status: 'failed',
      attempts,
      last_error: lastError,
      updated_at: new Date(),
    });
  }

  private mapRow(row: NotificationRow): Notification {
    const payload =
      typeof row.payload === 'string'
        ? (JSON.parse(row.payload) as NotificationPayload)
        : row.payload;

    const notification: Notification = {
      id: row.id,
      status: row.status as NotificationStatus,
      attempts: row.attempts,
      payload,
      scheduledAt: toIso(row.scheduled_at),
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
    if (row.last_error) notification.lastError = row.last_error;
    return notification;
  }
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
