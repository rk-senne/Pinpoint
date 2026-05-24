// FakeNotificationQueue — in-memory NotificationQueue fake
// (Phase 1.5 / task 4.11.1).
//
// Holds notification rows in a Map keyed by id. `enqueue`, `claimDue`,
// `markSent`, `markFailed`, and `markPending` faithfully implement the
// state transitions described by the port; the fake is enough to drive
// the dispatcher use case end-to-end without touching Postgres.

import { randomUUID } from 'node:crypto';

import type {
  Notification,
  NotificationPayload,
  NotificationStatus,
} from '../../domain/notification/Notification.js';
import type { NotificationQueue } from '../../domain/notification/ports/NotificationQueue.js';
import type { Clock } from '../../domain/shared/ports/Clock.js';

export class FakeNotificationQueue implements NotificationQueue {
  /** Public for direct assertion in tests; ordered by insertion. */
  readonly rows = new Map<string, Notification>();

  constructor(private readonly clock: Clock) {}

  async enqueue(payload: NotificationPayload, scheduledAt: Date): Promise<string> {
    const id = randomUUID();
    const now = this.clock.now().toISOString();
    const row: Notification = {
      id,
      status: 'pending',
      attempts: 0,
      payload,
      scheduledAt: scheduledAt.toISOString(),
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(id, row);
    return id;
  }

  async claimDue(limit: number, now: Date): Promise<Notification[]> {
    const due: Notification[] = [];
    for (const row of this.rows.values()) {
      if (row.status !== 'pending') continue;
      if (new Date(row.scheduledAt).getTime() > now.getTime()) continue;
      due.push(row);
    }
    due.sort(
      (a, b) =>
        new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime(),
    );
    // Return defensive copies so callers cannot mutate the stored rows.
    return due.slice(0, Math.max(0, limit)).map((r) => ({ ...r }));
  }

  async markSent(id: string): Promise<void> {
    this.transition(id, 'sent');
  }

  async markPending(
    id: string,
    attempts: number,
    scheduledAt: Date,
    lastError: string,
  ): Promise<void> {
    const row = this.rows.get(id);
    if (!row) return;
    this.rows.set(id, {
      ...row,
      status: 'pending',
      attempts,
      scheduledAt: scheduledAt.toISOString(),
      lastError,
      updatedAt: this.clock.now().toISOString(),
    });
  }

  async markFailed(id: string, attempts: number, lastError: string): Promise<void> {
    const row = this.rows.get(id);
    if (!row) return;
    this.rows.set(id, {
      ...row,
      status: 'failed',
      attempts,
      lastError,
      updatedAt: this.clock.now().toISOString(),
    });
  }

  /** Helper: list all rows in insertion order. */
  list(): Notification[] {
    return Array.from(this.rows.values()).map((r) => ({ ...r }));
  }

  private transition(id: string, status: NotificationStatus): void {
    const row = this.rows.get(id);
    if (!row) return;
    this.rows.set(id, {
      ...row,
      status,
      updatedAt: this.clock.now().toISOString(),
    });
  }
}
