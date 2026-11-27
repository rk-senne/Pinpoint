/**
 * widget.diagnostics.test.ts — Mission C2 (server). Verifies the ≤32 KB
 * serialized diagnostics budget enforced in `widget.routes.ts` and the
 * bounded shared Zod schemas that back the additive `consoleLogs`/`jsErrors`
 * payload fields.
 */

import { describe, expect, it } from 'vitest';

import {
  enforceDiagnosticsBudget,
  WIDGET_DIAGNOSTICS_MAX_BYTES,
} from './widget.routes.js';
import {
  ConsoleLogsSchema,
  JsErrorsSchema,
  DIAGNOSTICS_MAX_ENTRIES,
  DIAGNOSTICS_MESSAGE_MAX,
} from '@pinpoint/shared';

function consoleEntry(message: string) {
  return { level: 'error' as const, message, timestamp: new Date().toISOString() };
}

describe('enforceDiagnosticsBudget', () => {
  it('keeps small payloads untouched', () => {
    const consoleLogs = [consoleEntry('ok')];
    const out = enforceDiagnosticsBudget({ consoleLogs });
    expect(out.consoleLogs).toEqual(consoleLogs);
  });

  it('drops a field exceeding the 32 KB budget independently', () => {
    const big = Array.from({ length: 50 }, () => consoleEntry('z'.repeat(1000)));
    const small = [consoleEntry('fine')];
    const out = enforceDiagnosticsBudget({ consoleLogs: big, jsErrors: small });
    expect(Buffer.byteLength(JSON.stringify(big))).toBeGreaterThan(
      WIDGET_DIAGNOSTICS_MAX_BYTES,
    );
    expect(out.consoleLogs).toBeUndefined();
    expect(out.jsErrors).toEqual(small);
  });

  it('ignores nullish inputs', () => {
    expect(enforceDiagnosticsBudget({})).toEqual({});
    expect(enforceDiagnosticsBudget({ consoleLogs: null, jsErrors: undefined })).toEqual({});
  });
});

describe('shared diagnostics schemas', () => {
  it('rejects arrays longer than DIAGNOSTICS_MAX_ENTRIES', () => {
    const tooMany = Array.from({ length: DIAGNOSTICS_MAX_ENTRIES + 1 }, () =>
      consoleEntry('x'),
    );
    expect(ConsoleLogsSchema.safeParse(tooMany).success).toBe(false);
  });

  it('rejects over-length messages', () => {
    const bad = [consoleEntry('x'.repeat(DIAGNOSTICS_MESSAGE_MAX + 1))];
    expect(ConsoleLogsSchema.safeParse(bad).success).toBe(false);
  });

  it('accepts a valid bounded jsErrors payload', () => {
    const ok = [
      {
        kind: 'unhandledrejection' as const,
        message: 'nope',
        timestamp: new Date().toISOString(),
      },
    ];
    expect(JsErrorsSchema.safeParse(ok).success).toBe(true);
  });

  it('treats null as a valid (nullable) payload', () => {
    expect(ConsoleLogsSchema.safeParse(null).success).toBe(true);
  });
});
