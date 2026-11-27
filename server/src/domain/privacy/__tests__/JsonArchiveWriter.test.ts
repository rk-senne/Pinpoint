import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { JsonArchiveWriter } from '../JsonArchiveWriter.js';

async function build(max: number, fill: (w: JsonArchiveWriter) => Promise<void>) {
  const chunks: string[] = [];
  const w = new JsonArchiveWriter((c) => void chunks.push(c), max);
  await w.begin({ kind: 't' });
  await fill(w);
  await w.end();
  return { text: chunks.join(''), w };
}

describe('JsonArchiveWriter', () => {
  it('produces valid JSON with scalar and array sections and truncated=false', async () => {
    const { text, w } = await build(10_000, async (w2) => {
      await w2.value('profile', { id: 1, name: 'Zoë "quoted"\n' });
      await w2.beginArray('rows');
      expect(await w2.item({ a: 1 })).toBe(true);
      expect(await w2.item('two')).toBe(true);
      await w2.endArray();
      await w2.beginArray('empty');
      await w2.endArray();
    });
    expect(JSON.parse(text)).toEqual({
      meta: { kind: 't' },
      profile: { id: 1, name: 'Zoë "quoted"\n' },
      rows: [{ a: 1 }, 'two'],
      empty: [],
      truncated: false,
    });
    expect(w.isTruncated).toBe(false);
  });

  it('drops items past the cap, flags truncated, and stays valid JSON within the cap', async () => {
    const { text, w } = await build(300, async (w2) => {
      await w2.beginArray('rows');
      let accepted = 0;
      for (let i = 0; i < 100; i += 1) if (await w2.item({ i, pad: 'x'.repeat(40) })) accepted += 1;
      expect(accepted).toBeGreaterThan(0);
      expect(accepted).toBeLessThan(100);
      await w2.endArray();
    });
    const doc = JSON.parse(text);
    expect(doc.truncated).toBe(true);
    expect(w.isTruncated).toBe(true);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(300);
  });

  it('property: any sequence of items yields parseable JSON that never exceeds the cap', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.jsonValue(), { maxLength: 40 }), fc.integer({ min: 120, max: 2000 }), async (items, cap) => {
        const { text } = await build(cap, async (w) => {
          await w.beginArray('rows');
          for (const it of items) await w.item(it);
          await w.endArray();
        });
        const doc = JSON.parse(text);
        expect(Array.isArray(doc.rows)).toBe(true);
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(Math.max(cap, 120));
      }),
      { numRuns: 60 },
    );
  });

  it('guards misuse (item outside an array, value inside one)', async () => {
    const w = new JsonArchiveWriter(() => undefined, 1000);
    await expect(w.value('x', 1)).rejects.toThrow('not begun');
    await w.begin({});
    await expect(w.item(1)).rejects.toThrow('no open array');
    await w.beginArray('a');
    await expect(w.value('x', 1)).rejects.toThrow('array still open');
  });
});
