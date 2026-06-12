// Digest worker — daily digest email scheduler.
//
// Feature-flagged: only starts if `DIGEST_ENABLED=true`. Runs once every
// 24 hours, generates a digest for every org, and enqueues emails via the
// notification queue.

import type { Knex } from 'knex';

import type { DigestData } from '../../../services/dailyDigest.js';
import type { NotificationQueue } from '../../../domain/notification/ports/NotificationQueue.js';
import type { Logger } from '../../../domain/shared/ports/Logger.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export interface DigestWorkerDeps {
  db: Knex;
  notificationQueue: NotificationQueue;
  generateDailyDigest: (db: Knex, orgId: string) => Promise<DigestData>;
  logger: Logger;
  /** Polling cadence in milliseconds. Defaults to 24 hours. */
  intervalMs?: number;
}

export interface DigestWorker {
  start(): void;
  stop(): Promise<void>;
}

export function createDigestWorker(deps: DigestWorkerDeps): DigestWorker {
  const {
    db,
    notificationQueue,
    generateDailyDigest,
    logger,
    intervalMs = ONE_DAY_MS,
  } = deps;

  let handle: NodeJS.Timeout | null = null;
  let inFlight = false;
  let currentTick: Promise<void> | null = null;

  const tick = async (): Promise<void> => {
    if (inFlight) {
      logger.warn({}, 'digestWorker: previous tick still in flight, skipping');
      return;
    }

    inFlight = true;
    const promise = (async () => {
      try {
        const orgs = await db('organizations').select('id');
        for (const org of orgs) {
          const digest = await generateDailyDigest(db, org.id);
          // Enqueue as a notification email for the org owner(s)
          const owners = await db('memberships')
            .where({ org_id: org.id, role: 'owner' })
            .select('user_id');
          for (const owner of owners) {
            await notificationQueue.enqueue(
              {
                kind: 'annotation_created', // reuses existing kind for email dispatch
                recipientUserId: owner.user_id,
                subject: `Daily Digest — ${digest.newAnnotations} new items`,
                body: digest.insight,
                digestData: digest,
              },
              new Date(),
            );
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ error: message }, 'digestWorker: tick threw');
      } finally {
        inFlight = false;
        currentTick = null;
      }
    })();
    currentTick = promise;
    await promise;
  };

  return {
    start(): void {
      if (handle !== null) return;
      handle = setInterval(() => {
        void tick();
      }, intervalMs);
      handle.unref?.();
    },

    async stop(): Promise<void> {
      if (handle !== null) {
        clearInterval(handle);
        handle = null;
      }
      if (currentTick) {
        await currentTick;
      }
    },
  };
}
