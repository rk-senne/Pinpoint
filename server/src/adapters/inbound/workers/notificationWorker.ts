// Notification worker inbound adapter (Phase 1.5 / task 4.9.3).
//
// Drives the durable notification queue's consumer side: every
// `intervalMs` (default 5000 ms) it invokes the
// `dispatchPendingNotifications` use case with `batchSize` (default
// 10). The use case owns claim-and-send semantics; the worker is a
// thin scheduler.
//
// Concurrency: ticks are guarded by an `inFlight` flag so a slow tick
// can't be overlapped by the next interval fire. When a tick is
// skipped we log a `warn` so operators can spot dispatch falling
// behind. Errors thrown out of the use case are caught and logged at
// `error` level — the worker must never crash on a bad tick.
//
// Shutdown: `stop()` clears the interval and awaits any in-flight
// promise so callers can drain cleanly during graceful shutdown.

import type { DispatchPendingNotifications } from '../../../domain/notification/usecases/dispatchPendingNotifications.js';
import type { Logger } from '../../../domain/shared/ports/Logger.js';

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_BATCH_SIZE = 10;

export interface NotificationWorkerDeps {
  dispatchPendingNotifications: DispatchPendingNotifications;
  logger: Logger;
  /** Polling cadence in milliseconds. Defaults to 5000. */
  intervalMs?: number;
  /** Rows claimed per tick. Defaults to 10. */
  batchSize?: number;
}

export interface NotificationWorker {
  start(): void;
  stop(): Promise<void>;
}

export function createNotificationWorker(
  deps: NotificationWorkerDeps,
): NotificationWorker {
  const {
    dispatchPendingNotifications,
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
        'notificationWorker: previous tick still in flight, skipping',
      );
      return;
    }

    inFlight = true;
    const promise = (async () => {
      try {
        await dispatchPendingNotifications.execute({ batchSize });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(
          { error: message },
          'notificationWorker: dispatch tick threw',
        );
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
      if (handle !== null) {
        return;
      }
      handle = setInterval(() => {
        void tick();
      }, intervalMs);
      // Don't keep the event loop alive on the worker alone — matches
      // the legacy worker's `unref` behavior so one-shot scripts that
      // import the composition root still exit cleanly.
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
