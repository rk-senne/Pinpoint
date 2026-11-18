import express from 'express';
import { describe, expect, it } from 'vitest';
import { inputSanitizer } from './inputSanitizer.js';
import { hasPngSignature } from '../adapters/inbound/http/annotations.routes.js';

/** Drive the middleware directly: no socket, so no EPIPE when the server answers early. */
function run(method: string, url: string, contentLength: number): { status?: number; passed: boolean } {
  const out: { status?: number; passed: boolean } = { passed: false };
  const res = {
    status(c: number) { out.status = c; return this; },
    json() { return this; },
  } as unknown as express.Response;
  inputSanitizer({ method, originalUrl: url, url, headers: { 'content-length': String(contentLength) }, body: undefined } as unknown as express.Request, res, () => { out.passed = true; });
  return out;
}

describe('inputSanitizer body limits (PP-18)', () => {
  const MB = 1024 * 1024;
  it('lets a 5 MB multipart screenshot through but still caps ordinary bodies at 1 MB', () => {
    expect(run('POST', '/api/v1/annotations/abc/screenshot', 5 * MB).passed).toBe(true);
    expect(run('POST', '/api/v1/annotations/abc/screenshot?x=1', 5 * MB).passed).toBe(true);
    expect(run('POST', '/api/v1/annotations/abc/other', 5 * MB)).toMatchObject({ status: 413, passed: false });
    expect(run('PUT', '/api/v1/annotations/abc/screenshot', 5 * MB)).toMatchObject({ status: 413 });
    expect(run('POST', '/api/v1/projects/p/annotations', 2 * MB)).toMatchObject({ status: 413 });
  });

  it('rejects an upload over the 12 MB request ceiling', () => {
    expect(run('POST', '/api/v1/annotations/abc/screenshot', 13 * MB)).toMatchObject({ status: 413, passed: false });
  });
});

describe('hasPngSignature', () => {
  it('accepts real PNG bytes and rejects everything else', () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest')]);
    expect(hasPngSignature(png)).toBe(true);
    expect(hasPngSignature(Buffer.from('<script>alert(1)</script>'))).toBe(false);
    expect(hasPngSignature(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0]))).toBe(false);
    expect(hasPngSignature(undefined)).toBe(false);
    expect(hasPngSignature(Buffer.alloc(0))).toBe(false);
  });
});
