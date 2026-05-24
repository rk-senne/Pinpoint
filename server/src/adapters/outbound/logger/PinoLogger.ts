// Pino-backed Logger adapter (Phase 1.5 / task 4.8.8).
//
// Per the hexagonal architecture rules, this file is the ONLY place in
// the codebase that imports `pino` / `pino-http`. Domain code depends
// on the `Logger` port; the composition root wires this adapter in.
//
// The adapter is a thin wrapper around a pino logger instance: the
// port shape (`(context, message)` per level, plus `child(context)`)
// already mirrors pino's API, so each method is a one-line passthrough.
// We re-export `pino` and `pino-http` factories from this module so the
// rest of the codebase does not need to import them directly.

import pino from 'pino';
import type { Logger as PinoInstance } from 'pino';
import pinoHttp from 'pino-http';

import type {
  Logger as LoggerPort,
  LogContext,
} from '../../../domain/shared/ports/Logger.js';

export class PinoLogger implements LoggerPort {
  private readonly pino: PinoInstance;

  constructor(instance: PinoInstance) {
    this.pino = instance;
  }

  trace(context: LogContext, message: string): void {
    this.pino.trace(context, message);
  }

  debug(context: LogContext, message: string): void {
    this.pino.debug(context, message);
  }

  info(context: LogContext, message: string): void {
    this.pino.info(context, message);
  }

  warn(context: LogContext, message: string): void {
    this.pino.warn(context, message);
  }

  error(context: LogContext, message: string): void {
    this.pino.error(context, message);
  }

  child(context: LogContext): LoggerPort {
    return new PinoLogger(this.pino.child(context));
  }
}

// Re-exports kept here so the rest of the codebase obtains pino bindings
// exclusively via the adapter module. This preserves the "only place
// importing pino / pino-http" invariant: `server/src/logger.ts` and any
// future composition module can import these names from
// `adapters/outbound/logger/PinoLogger.js` instead of pulling pino in
// directly.
export { pino, pinoHttp };
export type { PinoInstance };
