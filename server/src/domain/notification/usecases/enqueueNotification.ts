// enqueueNotification use case (Phase 1.5 / task 4.7.6).
//
// Hex extraction of the producer side of the durable notification queue
// (Reqs 28.1 / 28.2). Producers (annotation create, comment create,
// shared-link verify, etc.) hand a `NotificationPayload` here; the use
// case stamps the `scheduledAt` from the Clock port and inserts a
// `pending` row through `NotificationQueue.enqueue`.
//
// The optional `delayMs` lets callers schedule a future delivery (e.g.,
// a "verify your email" reminder). The default is 0 — deliver as soon
// as the dispatcher picks the row up. We do NOT consult user preferences
// here; that gate lives in `enqueueIfPreferred` in the inbound code that
// owns event-to-payload mapping. This use case is the durable handoff
// once the producer has decided the row should exist.

import type { NotificationPayload } from '../Notification.js';
import type { NotificationQueue } from '../ports/NotificationQueue.js';
import type { Clock } from '../../shared/ports/Clock.js';
import {
  type DomainError,
  type Result,
  ok,
} from '../../shared/DomainError.js';

export interface EnqueueNotificationInput {
  payload: NotificationPayload;
  /** Defer delivery this many ms past `clock.now()`. Defaults to 0. */
  delayMs?: number;
}

export interface EnqueueNotificationOutput {
  /** Queue row id; useful for log correlation and tests. */
  notificationId: string;
}

export interface EnqueueNotificationDeps {
  notificationQueue: NotificationQueue;
  clock: Clock;
}

export class EnqueueNotification {
  constructor(private readonly deps: EnqueueNotificationDeps) {}

  async execute(
    input: EnqueueNotificationInput,
  ): Promise<Result<EnqueueNotificationOutput, DomainError>> {
    const { notificationQueue, clock } = this.deps;
    const delayMs = input.delayMs ?? 0;
    const scheduledAt = new Date(clock.now().getTime() + delayMs);

    const id = await notificationQueue.enqueue(input.payload, scheduledAt);
    return ok({ notificationId: id });
  }
}
