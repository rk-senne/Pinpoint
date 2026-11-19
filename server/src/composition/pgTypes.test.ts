import { describe, it, expect } from 'vitest';
import pg from 'pg';
import { registerPgTypeParsers } from './pgTypes.js';
import { dueDateOnly } from '../adapters/outbound/report/PdfKitReportRenderer.js';

describe('registerPgTypeParsers', () => {
  it('keeps Postgres `date` (OID 1082) as the literal YYYY-MM-DD string', () => {
    registerPgTypeParsers();
    registerPgTypeParsers(); // idempotent
    expect(pg.types.getTypeParser(1082)('2026-12-24')).toBe('2026-12-24');
  });

  it('does not touch timestamptz parsing (OID 1184)', () => {
    registerPgTypeParsers();
    expect(pg.types.getTypeParser(1184)('2026-12-24 10:00:00+00')).toBeInstanceOf(Date);
  });
});

describe('dueDateOnly (report renderer)', () => {
  it('passes date strings through and never shifts by the UTC offset', () => {
    expect(dueDateOnly('2026-12-24')).toBe('2026-12-24');
    // A Date built at LOCAL midnight (how node-pg parses `date` without our
    // parser) must render as the same calendar day in any server timezone.
    expect(dueDateOnly(new Date(2026, 11, 24))).toBe('2026-12-24');
  });
});
