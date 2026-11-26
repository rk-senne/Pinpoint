import express from 'express';
import { describe, expect, it } from 'vitest';
import { request } from '../__tests__/supertestClient.js';
import { compress } from './compress.js';

const big = { rows: Array.from({ length: 200 }, (_, i) => ({ i, text: 'lorem ipsum dolor sit amet' })) };

function app(threshold?: number) {
  const a = express();
  a.use(compress(threshold));
  a.get('/big', (_q, r) => { r.json(big); });
  a.get('/small', (_q, r) => { r.json({ ok: true }); });
  return a;
}

describe('compress middleware', () => {
  it('gzips JSON above the threshold when the client accepts gzip', async () => {
    const res = await request(app()).get('/big').set('Accept-Encoding', 'gzip');
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers['vary']).toMatch(/Accept-Encoding/i);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    // superagent transparently gunzips, so a parsed body proves the payload round-trips.
    expect(res.body).toEqual(big);
  });

  it('leaves small payloads uncompressed', async () => {
    const res = await request(app()).get('/small').set('Accept-Encoding', 'gzip');
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body).toEqual({ ok: true });
  });

  it('does nothing when the client does not advertise gzip', async () => {
    const res = await request(app()).get('/big').set('Accept-Encoding', 'identity');
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body).toEqual(big);
  });

  it('honours a custom threshold', async () => {
    const res = await request(app(1)).get('/small').set('Accept-Encoding', 'gzip');
    expect(res.headers['content-encoding']).toBe('gzip');
  });
});
