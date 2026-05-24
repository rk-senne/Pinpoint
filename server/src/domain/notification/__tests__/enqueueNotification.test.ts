// Unit tests for the enqueueNotification use case (Phase 1.5 / task 4.11.2).

import { describe, it, expect } from 'vitest';

import {
  FakeClock,
  FakeNotificationQueue,
} from '../../../__tests__/fakes/index.js';
import { EnqueueNotification } from '../usecases/enqueueNotification.js';

function buildSut() {
  const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
  const notificationQueue = new FakeNotificationQueue(clock);
  const usecase = new EnqueueNotification({ notificationQueue, clock });
  return { usecase, clock, notificationQueue };
}

describe('enqueueNotification use case', () => {
  it('inserts a pending row scheduled at clock.now() by default', async () => {
    const { usecase, clock, notificationQueue } = buildSut();

    const result = await usecase.execute({
      payload: {
        kind: 'comment_created',
        recipientUserId: 'user-1',
        annotationId: 'a-1',
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(notificationQueue.rows.size).toBe(1);
    const row = notificationQueue.rows.get(result.value.notificationId)!;
    expect(row.status).toBe('pending');
    expect(row.scheduledAt).toBe(clock.now().toISOString());
  });

  it('schedules a future delivery when delayMs is supplied', async () => {
    const { usecase, clock, notificationQueue } = buildSut();

    const result = await usecase.execute({
      payload: {
        kind: 'verify_email',
        recipientUserId: 'user-1',
        link: 'https://app.test/verify/abc',
      },
      delayMs: 60_000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = notificationQueue.rows.get(result.value.notificationId)!;
    const scheduled = new Date(row.scheduledAt).getTime();
    expect(scheduled).toBe(clock.now().getTime() + 60_000);
  });
});
