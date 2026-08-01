// Integration token refresh worker (Task 3).
// Runs every 5 minutes; refreshes expiring OAuth tokens.

import type { Knex } from 'knex';
import type { Logger } from '../../../domain/shared/ports/Logger.js';
import { refreshExpiredTokens } from '../../../services/integrationTokenRefresh.js';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

export interface IntegrationRefreshWorkerDeps {
  db: Knex;
  logger: Logger;
  intervalMs?: number;
}

export interface IntegrationRefreshWorker {
  start(): void;
  stop(): Promise<void>;
}

export function createIntegrationRefreshWorker(
  deps: IntegrationRefreshWorkerDeps,
): IntegrationRefreshWorker {
  const { db, logger, intervalMs = DEFAULT_INTERVAL_MS } = deps;

  let handle: NodeJS.Timeout | null = null;
  let inFlight = false;
  let currentTick: Promise<void> | null = null;

  const tick = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    const promise = (async () => {
      try {
        await refreshExpiredTokens(db);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ error: message }, 'integrationRefreshWorker: tick threw');
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
      if (handle !== null) { clearInterval(handle); handle = null; }
      if (currentTick) await currentTick;
    },
  };
}
