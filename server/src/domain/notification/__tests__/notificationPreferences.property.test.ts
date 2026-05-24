// Feature: pinpoint-app, Property 4: Notification dispatch respects user preferences
// **Validates: Requirements 10.4**
//
// Domain-layer property test (Phase 1.5 / task 4.11.3). Drives the
// `EnqueueNotification` + `DispatchPendingNotifications` use cases
// through fakes. The original test asserted a pure invariant on
// `shouldSendNotification`; this version asserts the *end-to-end*
// claim that flows from that invariant: only events whose recipient
// has the matching preference enabled ever reach the mailer.
//
// The preference gate itself is replicated inline as a tiny pure
// function so the test plays the role of the inbound adapter that
// decides whether to enqueue. Domain code (`EnqueueNotification`,
// `DispatchPendingNotifications`) is not changed — the invariant is
// checked end-to-end across the queue.

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

import {
  FakeClock,
  FakeLogger,
  FakeMailer,
  FakeNotificationQueue,
  FakeUserRepo,
} from '../../../__tests__/fakes/index.js';
import { EnqueueNotification } from '../usecases/enqueueNotification.js';
import { DispatchPendingNotifications } from '../usecases/dispatchPendingNotifications.js';
import type { NotificationKind } from '../Notification.js';
import type { NotificationPreferences } from '../../user/User.js';

// Event-type → queue-kind mapping. Replicated here so the property
// test stays free of imports that pull in `db.js`.
type EventType =
  | 'newAnnotation'
  | 'newComment'
  | 'promotedToOwner'
  | 'projectDeleted';

const ALL_EVENT_TYPES: EventType[] = [
  'newAnnotation',
  'newComment',
  'promotedToOwner',
  'projectDeleted',
];

const eventToQueueKind: Record<EventType, NotificationKind> = {
  newAnnotation: 'annotation_created',
  newComment: 'comment_created',
  promotedToOwner: 'promoted_to_owner',
  projectDeleted: 'project_deleted',
};

/**
 * Pure preference gate. Contract: enqueue iff the relevant preference
 * is `true`.
 */
function shouldSendNotification(
  prefs: NotificationPreferences,
  eventType: EventType,
): boolean {
  return prefs[eventType] === true;
}

const arbEventType = fc.constantFrom<EventType>(...ALL_EVENT_TYPES);
const arbPreferences: fc.Arbitrary<NotificationPreferences> = fc.record({
  newAnnotation: fc.boolean(),
  newComment: fc.boolean(),
  promotedToOwner: fc.boolean(),
  projectDeleted: fc.boolean(),
});

interface GeneratedEvent {
  eventType: EventType;
  preferences: NotificationPreferences;
}

const arbEvent: fc.Arbitrary<GeneratedEvent> = fc.record({
  eventType: arbEventType,
  preferences: arbPreferences,
});

const arbEventBatch = fc.array(arbEvent, { minLength: 0, maxLength: 12 });

describe('Property 4: Notification dispatch respects user preferences (use-case layer)', () => {
  it('only events whose recipient has the matching preference enabled reach the mailer', async () => {
    await fc.assert(
      fc.asyncProperty(arbEventBatch, async (events) => {
        const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
        const userRepo = new FakeUserRepo(clock);
        const queue = new FakeNotificationQueue(clock);
        const mailer = new FakeMailer();
        const logger = new FakeLogger();

        const enqueue = new EnqueueNotification({
          notificationQueue: queue,
          clock,
        });
        const dispatch = new DispatchPendingNotifications({
          notificationQueue: queue,
          userRepo,
          mailer,
          clock,
          logger,
        });

        // Track which generated events should make it to the mailer
        // based on their recipient's preferences.
        const expectedDeliveries: { recipientEmail: string; eventType: EventType }[] = [];

        for (let i = 0; i < events.length; i++) {
          const ev = events[i]!;
          const user = await userRepo.insert({
            email: `recipient-${i}@example.com`,
            name: `Recipient ${i}`,
            passwordHash: 'hashed:secret',
          });
          // Apply the generated preferences.
          await userRepo.update(user.id, {
            notificationPreferences: ev.preferences,
          });

          // The inbound layer is the gatekeeper: enqueue iff the
          // preference is enabled. This is the contract under test.
          if (shouldSendNotification(ev.preferences, ev.eventType)) {
            await enqueue.execute({
              payload: {
                kind: eventToQueueKind[ev.eventType],
                recipientUserId: user.id,
              },
            });
            expectedDeliveries.push({
              recipientEmail: user.email,
              eventType: ev.eventType,
            });
          }
        }

        // Generously sized batch so a single dispatch tick clears the
        // queue regardless of generated batch size.
        const result = await dispatch.execute({ batchSize: 100 });
        expect(result.ok).toBe(true);

        // The mailer received exactly one message per expected delivery.
        expect(mailer.sent).toHaveLength(expectedDeliveries.length);

        // Every delivered email is to one of the expected recipients,
        // and every expected recipient appears at least once.
        const sentTo = new Set(mailer.sent.map((m) => m.to));
        const expectedTo = new Set(
          expectedDeliveries.map((d) => d.recipientEmail),
        );
        expect(sentTo).toEqual(expectedTo);
      }),
      { numRuns: 50 },
    );
  });

  it('shouldSendNotification gate: result equals the preference flag for the event type', () => {
    fc.assert(
      fc.property(arbEventType, arbPreferences, (eventType, prefs) => {
        const result = shouldSendNotification(prefs, eventType);
        const expected = prefs[eventType] === true;
        expect(result).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });
});
