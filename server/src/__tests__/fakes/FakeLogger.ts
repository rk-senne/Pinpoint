// FakeLogger — in-memory Logger fake (Phase 1.5 / task 4.11.1).
//
// Captures every level call into a public `logs` array so tests can
// assert on emitted records without binding to pino. `child(context)`
// returns a fresh fake that prefixes its bound context onto every record
// while sharing the same underlying `logs` array, mirroring the
// inheritance semantics of pino.

import type {
  Logger,
  LogContext,
} from '../../domain/shared/ports/Logger.js';

export type FakeLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

export interface FakeLogRecord {
  level: FakeLogLevel;
  ctx: LogContext;
  msg: string;
}

export class FakeLogger implements Logger {
  /** Public for direct assertion in tests. */
  readonly logs: FakeLogRecord[];
  private readonly bindings: LogContext;

  constructor(bindings: LogContext = {}, sharedLogs: FakeLogRecord[] = []) {
    this.bindings = { ...bindings };
    this.logs = sharedLogs;
  }

  trace(context: LogContext, message: string): void {
    this.record('trace', context, message);
  }

  debug(context: LogContext, message: string): void {
    this.record('debug', context, message);
  }

  info(context: LogContext, message: string): void {
    this.record('info', context, message);
  }

  warn(context: LogContext, message: string): void {
    this.record('warn', context, message);
  }

  error(context: LogContext, message: string): void {
    this.record('error', context, message);
  }

  child(context: LogContext): Logger {
    return new FakeLogger({ ...this.bindings, ...context }, this.logs);
  }

  private record(level: FakeLogLevel, ctx: LogContext, msg: string): void {
    this.logs.push({ level, ctx: { ...this.bindings, ...ctx }, msg });
  }
}
