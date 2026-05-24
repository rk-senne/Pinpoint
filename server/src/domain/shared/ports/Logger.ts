// Logger port (Phase 1.5 / task 4.6.2).
//
// Domain code may emit structured log records without depending on pino
// directly; the outbound `logger` adapter wraps the chosen library. Each
// method takes an arbitrary string-keyed bag of context fields plus the
// human-readable message, matching the pino shape but staying independent
// of the implementation.

export type LogContext = Record<string, unknown>;

export interface Logger {
  trace(context: LogContext, message: string): void;
  debug(context: LogContext, message: string): void;
  info(context: LogContext, message: string): void;
  warn(context: LogContext, message: string): void;
  error(context: LogContext, message: string): void;

  /** Bind extra context that every subsequent record inherits. */
  child(context: LogContext): Logger;
}
