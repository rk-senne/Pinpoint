// Process entrypoint (Phase 1.5 / task 4.10.2).
//
// Responsibilities are intentionally minimal:
//   1. Load `.env` so `process.env` reflects the local environment.
//   2. Build the configuration record via `loadConfigFromEnv`.
//   3. Hand the config to `buildContainer`, which constructs every
//      adapter, every use case, and the inbound surface (HTTP routers,
//      WebSocket gateway, notification worker).
//   4. In non-test environments, validate the production secret guard,
//      call `container.start()`, and wire SIGTERM/SIGINT to
//      `container.stop()` for graceful shutdown.
//
// `app` and `httpServer` exports are preserved for the few existing
// supertest-based tests still pointing at this module; they pull the
// values out of the container so the surface stays identical.

import dotenv from 'dotenv';

import { validateConfig } from './config.js';
import { buildContainer, loadConfigFromEnv, type Container } from './composition/container.js';
import { logger } from './logger.js';

dotenv.config();

const config = loadConfigFromEnv();
const container: Container = buildContainer(config);

export const app = container.app;
export const httpServer = container.httpServer;
export default app;

async function main(): Promise<void> {
  try {
    validateConfig();
  } catch (err) {
    logger.error({ err }, 'Configuration validation failed');
    process.exit(1);
  }

  await container.start();

  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, 'Received shutdown signal — stopping container');
    container
      .stop()
      .then(() => process.exit(0))
      .catch((err) => {
        logger.error({ err }, 'Error during graceful shutdown');
        process.exit(1);
      });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (process.env.NODE_ENV !== 'test') {
  void main();
}
