// Unit tests for the dispatchPendingNotifications use case
// (Phase 1.5 / task 4.11.2).

import { describe, it, expect } from 'vitest';

import {
  FakeClock,
  FakeLogger,
  FakeMailer,
  FakeNotificationQueue,
  FakeUserRepo,
} from '../../../__tests__/fakes/index.js';
import { DispatchPendingNotifications, renderTemplate } from '../usecases/dispatchPendingNotifications.js';

async function buildSut() {
  const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
  const userRepo = new FakeUserRepo(clock);
  const mailer = new FakeMailer();
  const notificationQueue = new FakeNotificationQueue(clock);
  const logger = new FakeLogger();

  const user = await userRepo.insert({
    email: 'recipient@example.com',
    name: 'Recipient',
    passwordHash: 'h',
    verified: true,
  });

  const usecase = new DispatchPendingNotifications({
    notificationQueue,
    userRepo,
    mailer,
    clock,
    logger,
  });

  return { usecase, user, mailer, notificationQueue, logger };
}

describe('dispatchPendingNotifications use case', () => {
  it('claims pending rows, sends mail, and marks rows sent', async () => {
    const { usecase, user, mailer, notificationQueue } = await buildSut();

    const id = await notificationQueue.enqueue(
      {
        kind: 'comment_created',
        recipientUserId: user.id,
        annotationId: 'a-1',
      },
      new Date('2024-06-01T00:00:00Z'),
    );

    const result = await usecase.execute();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.dispatched).toEqual([
      { id, outcome: 'sent' },
    ]);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toBe('recipient@example.com');
    expect(notificationQueue.rows.get(id)?.status).toBe('sent');
  });

  it('marks rows failed when the recipient cannot be resolved', async () => {
    const { usecase, mailer, notificationQueue, logger } = await buildSut();

    const id = await notificationQueue.enqueue(
      {
        kind: 'comment_created',
        recipientUserId: 'no-such-user',
        annotationId: 'a-1',
      },
      new Date('2024-06-01T00:00:00Z'),
    );

    const result = await usecase.execute();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.dispatched[0]!.outcome).toBe('failed');
    expect(mailer.sent).toHaveLength(0);
    expect(notificationQueue.rows.get(id)?.status).toBe('failed');
    expect(logger.logs.some((l) => l.level === 'warn')).toBe(true);
  });
});

describe('renderTemplate escaping (PP-17)', () => {
  const evil = '<img src=x onerror=alert(1)>"&\r\nBcc: attacker@evil.test';

  it.each([
    ['annotation_created', { projectName: evil }],
    ['comment_on_own', { actorName: evil, pinNumber: evil }],
    ['mention', { actorName: evil, pinNumber: evil }],
    ['status_change', { actorName: evil, pinNumber: evil, newStatus: evil }],
    ['daily_digest', { insight: evil }],
    ['promoted_to_owner', { projectName: evil }],
    ['project_deleted', { projectName: evil }],
  ] as const)('%s: no raw markup in the body, no CR/LF in the subject', (kind, extra) => {
    const { subject, body } = renderTemplate({ kind, ...extra } as never);
    expect(body).not.toContain('<img');
    expect(body).not.toContain('onerror=alert(1)>');
    expect(body).toContain('&lt;img');
    expect(subject).not.toMatch(/[\r\n]/);
  });
});
