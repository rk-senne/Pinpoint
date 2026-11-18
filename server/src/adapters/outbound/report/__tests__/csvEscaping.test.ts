// Unit tests for CSV formula-injection escaping (Mission B2 / Req B2).
//
// A spreadsheet treats a cell whose first character is `= + - @ \t \r` as a
// formula on open — the classic payload is `=cmd|' /C calc'!A0`. The renderer
// must neutralise the leading character with a single quote while preserving
// the value on round-trip parse, and must keep CSV structure intact for
// values containing commas, quotes, and newlines.

import { describe, it, expect } from 'vitest';

import { encodeCsvCell } from '../PdfKitReportRenderer.js';

/**
 * Minimal RFC-4180 single-cell parser: strips the surrounding quotes and
 * un-doubles inner quotes. Mirrors how a spreadsheet re-reads one quoted
 * field so tests can assert the round-trip value.
 */
function parseCsvCell(encoded: string): string {
  expect(encoded.startsWith('"')).toBe(true);
  expect(encoded.endsWith('"')).toBe(true);
  return encoded.slice(1, -1).replace(/""/g, '"');
}

describe('encodeCsvCell — formula-injection guard', () => {
  const DANGEROUS_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

  it('prefixes a single quote to a classic formula payload', () => {
    const payload = `=cmd|' /C calc'!A0`;
    const encoded = encodeCsvCell(payload);
    const parsed = parseCsvCell(encoded);
    expect(parsed).toBe(`'${payload}`);
    // The dangerous leading `=` is no longer first after import.
    expect(parsed.startsWith('=')).toBe(false);
  });

  it.each(DANGEROUS_PREFIXES)(
    'neutralises a cell starting with %j',
    (prefix) => {
      const parsed = parseCsvCell(encodeCsvCell(`${prefix}danger`));
      expect(parsed).toBe(`'${prefix}danger`);
    },
  );

  it('does not alter benign leading characters', () => {
    expect(parseCsvCell(encodeCsvCell('Safe value'))).toBe('Safe value');
    expect(parseCsvCell(encodeCsvCell('123'))).toBe('123');
    expect(parseCsvCell(encodeCsvCell('user@example.com starts safe'))).toBe(
      'user@example.com starts safe',
    );
  });

  it('leaves an interior = / + / - untouched', () => {
    expect(parseCsvCell(encodeCsvCell('a=b+c-d@e'))).toBe('a=b+c-d@e');
  });
});

describe('encodeCsvCell — CSV structure', () => {
  it('doubles embedded quotes and wraps in quotes', () => {
    expect(encodeCsvCell('he said "hi"')).toBe('"he said ""hi"""');
  });

  it('keeps commas and newlines inside the quoted field', () => {
    const encoded = encodeCsvCell('a, b\nc');
    const parsed = parseCsvCell(encoded);
    expect(parsed).toBe('a, b\nc');
  });

  it('coerces non-string values', () => {
    expect(parseCsvCell(encodeCsvCell(42))).toBe('42');
    expect(parseCsvCell(encodeCsvCell(''))).toBe('');
  });

  it('neutralises a formula payload that also contains CSV metacharacters', () => {
    const payload = `=HYPERLINK("http://evil","x"),y`;
    const parsed = parseCsvCell(encodeCsvCell(payload));
    expect(parsed).toBe(`'${payload}`);
  });
});
