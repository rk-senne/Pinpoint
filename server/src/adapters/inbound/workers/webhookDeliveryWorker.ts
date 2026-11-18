// Webhook delivery worker inbound adapter (Mission A5b).
//
// Consumer side of the durable webhook delivery queue. Mirrors
// notificationWorker: every `intervalMs` (default 5000 ms) it invokes the
// `DispatchWebhookDeliveries` use case with `batchSize` (default 10). The use
// case owns claim-and-send semantics (`SELECT … FOR UPDATE SKIP LOCKED`,
// exponential backoff, mark sent/failed); the worker is a thin scheduler.
//
// Because delivery rows are inserted `pending` BEFORE any HTTP attempt and are
// only transitioned to `sent`/`failed` once a terminal outcome is reached, a
// SIGTERM mid-backoff can't drop a delivery: the next boot's first tick
// reclaims every still-`pending` row whose `scheduled_at` has passed.
//
// Concurrency: ticks are guarded by an `inFlight` flag so a slow tick can't be
// overlapped by the next interval fire. Errors are caught + logged so a bad
// tick never crashes the worker. `stop()` clears the interval and awaits any
// in-flight promise for a clean drain on graceful shutdown.

import type { DispatchWebhookDeliveries } from '../../../domain/webhook/usecases/webhooks.js';
import type { Logger } from '../../../domain/shared/ports/Logger.js';

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_BATCH_SIZE = 10;

export interface WebhookDeliveryWorkerDeps {
  dispatchWebhookDeliveries: DispatchWebhookDeliveries;
  logger: Logger;
  /** Polling cadence in milliseconds. Defaults to 5000. */
  intervalMs?: number;
  /** Rows claimed per tick. Defaults to 10. */
  batchSize?: number;
}

export interface WebhookDeliveryWorker {
  start(): void;
  stop(): Promise<void>;
}

export function createWebhookDeliveryWorker(
  deps: WebhookDeliveryWorkerDeps,
): WebhookDeliveryWorker {
  const {
    dispatchWebhookDeliveries,
    logger,
    intervalMs = DEFAULT_INTERVAL_MS,
    batchSize = DEFAULT_BATCH_SIZE,
  } = deps;

  let handle: NodeJS.Timeout | null = null;
  let inFlight = false;
  let currentTick: Promise<void> | null = null;

  const tick = async (): Promise<void> => {
    if (inFlight) {
      logger.warn(
        { batchSize, intervalMs },
        'webhookDeliveryWorker: previous tick still in flight, skipping',
      );
      return;
    }

    inFlight = true;
    const promise = (async () => {
      try {
        await dispatchWebhookDeliveries.execute({ batchSize });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ error: message }, 'webhookDeliveryWorker: dispatch tick threw');
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
      handle = setInterval(() => { void tick(); }, intervalMs);
      handle.unref?.();
    },

    async stop(): Promise<void> {
      if (handle !== null) {
        clearInterval(handle);
        handle = null;
      }
      if (currentTick) await currentTick;
    },
  };
}
