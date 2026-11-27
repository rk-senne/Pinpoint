import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LocalFsScreenshotStore,
  InvalidStorageKeyError,
  assertSafeKey,
} from './LocalFsScreenshotStore.js';
import { localStoreAsS3Reader } from './s3Compat.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('payload')]);
const ANNOTATION_ID = '11111111-2222-3333-4444-555555555555';

describe('LocalFsScreenshotStore (real fs)', () => {
  let dir: string;
  let outside: string;
  let now: number;
  let store: LocalFsScreenshotStore;

  const make = (secret = 'unit-test-secret'): LocalFsScreenshotStore =>
    new LocalFsScreenshotStore({
      dir,
      signingSecret: secret,
      publicBaseUrl: 'https://pinpoint.example.com/',
      now: () => now,
    });

  beforeEach(async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'pp-localfs-'));
    dir = path.join(base, 'shots');
    outside = path.join(base, 'secret.txt');
    await fs.writeFile(outside, 'top secret');
    now = 1_700_000_000_000;
    store = make();
  });

  afterEach(async () => {
    await fs.rm(path.dirname(dir), { recursive: true, force: true });
  });

  it('round-trips a screenshot and its markup document', async () => {
    const up = await store.uploadScreenshot({ annotationId: ANNOTATION_ID, body: PNG, contentType: 'image/png' });
    expect(up.objectKey).toMatch(new RegExp(`^annotations/screenshots/${ANNOTATION_ID}/[0-9a-f]{16}\\.png$`));
    expect(await store.fetchScreenshot(up.objectKey)).toEqual(PNG);

    const markup = { version: 1, shapes: [{ kind: 'rect' }] };
    const m = await store.uploadMarkupDocument({ screenshotKey: up.objectKey, markupDocument: markup });
    expect(m.objectKey).toBe(`${up.objectKey}.markup.json`);
    expect(await store.fetchMarkupDocument(up.objectKey)).toEqual(markup);
  });

  it('returns null for missing screenshot / markup', async () => {
    expect(await store.fetchScreenshot(`annotations/screenshots/${ANNOTATION_ID}/nope.png`)).toBeNull();
    expect(await store.fetchMarkupDocument(`annotations/screenshots/${ANNOTATION_ID}/nope.png`)).toBeNull();
  });

  it('creates directories 0700 and files 0600, leaving no temp files behind', async () => {
    const up = await store.uploadScreenshot({ annotationId: ANNOTATION_ID, body: PNG, contentType: 'image/png' });
    const file = store.resolveKeyPath(up.objectKey);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    for (const d of [path.dirname(file), dir]) {
      expect((await fs.stat(d)).mode & 0o777).toBe(0o700);
    }
    const siblings = await fs.readdir(path.dirname(file));
    expect(siblings.filter((n) => n.startsWith('.tmp-'))).toEqual([]);
  });

  it('write is atomic: a failed write leaves neither a partial target nor a temp file', async () => {
    const key = `annotations/screenshots/${ANNOTATION_ID}/x.png`;
    // Make the target a directory so rename() fails after the temp file is written.
    await fs.mkdir(store.resolveKeyPath(key), { recursive: true });
    await expect(
      // @ts-expect-error private access for the failure-path test
      store.writeAtomic(key, PNG),
    ).rejects.toBeDefined();
    const left = await fs.readdir(path.dirname(store.resolveKeyPath(key)));
    expect(left.filter((n) => n.startsWith('.tmp-'))).toEqual([]);
  });

  describe('path traversal', () => {
    const evil = [
      '../secret.txt',
      '../../etc/passwd',
      'annotations/../../secret.txt',
      'annotations/screenshots/../../../secret.txt',
      '/etc/passwd',
      '/abs/path.png',
      'a\\..\\b.png',
      'a/./b.png',
      'a//b.png',
      'a/b/..',
      'a/..b/c.png',
      'a%2e%2e/b.png',
      '..%2fsecret.txt',
      'a/b\0.png',
      'a/b c.png',
      '',
      '.hidden/x.png',
      'a/b.png/',
      'x'.repeat(600),
    ];

    it.each(evil)('assertSafeKey rejects %j', (key) => {
      expect(() => assertSafeKey(key)).toThrow(InvalidStorageKeyError);
    });

    it('fetch never reads outside the root and reports null', async () => {
      for (const key of evil) expect(await store.fetchScreenshot(key)).toBeNull();
      expect(await store.fetchScreenshot(path.relative(dir, outside))).toBeNull();
    });

    it('upload/markup with traversal keys throws and writes nothing outside', async () => {
      await expect(
        store.uploadScreenshot({ annotationId: '../../evil', body: PNG, contentType: 'image/png' }),
      ).rejects.toBeInstanceOf(InvalidStorageKeyError);
      await expect(
        store.uploadMarkupDocument({ screenshotKey: '../../evil.png', markupDocument: {} }),
      ).rejects.toBeInstanceOf(InvalidStorageKeyError);
      const parent = await fs.readdir(path.dirname(dir));
      expect(parent.filter((n) => n.includes('evil'))).toEqual([]);
      expect(await fs.readFile(outside, 'utf8')).toBe('top secret');
    });

    it('a symlink-free key that resolves inside the root is accepted', () => {
      expect(store.resolveKeyPath('annotations/screenshots/a-b_c/0123.png').startsWith(dir + path.sep)).toBe(true);
    });
  });

  describe('signed URLs', () => {
    const key = `annotations/screenshots/${ANNOTATION_ID}/abc.png`;

    it('builds an absolute, 15-minute URL under /api/v1/screenshots and verifies it', async () => {
      const url = await store.presignScreenshotUrl(key);
      expect(url.startsWith('https://pinpoint.example.com/api/v1/screenshots/')).toBe(true);
      const token = url.split('/api/v1/screenshots/')[1]!;
      expect(store.verifyToken(token)).toBe(key);
      const exp = Number(token.split('.')[1]);
      expect(exp).toBe(1_700_000_000 + 900);
      expect(store.buildScreenshotUrl(key)).toBe(url);
    });

    it('rejects expired tokens', () => {
      const token = store.signToken(key, 900);
      now += 899_000;
      expect(store.verifyToken(token)).toBe(key);
      now += 2_000;
      expect(store.verifyToken(token)).toBeNull();
    });

    it('rejects tampered key, tampered expiry, other secret, and garbage', () => {
      const [k, e, s] = store.signToken(key, 900).split('.') as [string, string, string];
      const otherKey = Buffer.from('annotations/screenshots/other/abc.png').toString('base64url');
      expect(store.verifyToken(`${otherKey}.${e}.${s}`)).toBeNull();
      expect(store.verifyToken(`${k}.${Number(e) + 999}.${s}`)).toBeNull();
      expect(store.verifyToken(`${k}.${e}.${s.slice(0, -2)}AA`)).toBeNull();
      expect(make('different-secret').verifyToken(`${k}.${e}.${s}`)).toBeNull();
      for (const bad of ['', 'a', 'a.b', 'a.b.c', `${k}.${e}`, `${k}.${e}.${s}.x`, `${k}.-1.${s}`]) {
        expect(store.verifyToken(bad)).toBeNull();
      }
    });

    it('refuses to sign an unsafe key', () => {
      expect(() => store.signToken('../secret.txt', 60)).toThrow(InvalidStorageKeyError);
    });

    it('a validly signed token for a traversal key cannot be minted, and a forged one is rejected', () => {
      const payload = `${Buffer.from('../secret.txt').toString('base64url')}.${1_700_000_900}`;
      expect(store.verifyToken(`${payload}.AAAA`)).toBeNull();
    });
  });

  it('s3 compat reader serves GetObject from disk and throws NoSuchKey otherwise', async () => {
    const up = await store.uploadScreenshot({ annotationId: ANNOTATION_ID, body: PNG, contentType: 'image/png' });
    const client = localStoreAsS3Reader(store);
    const send = client.send.bind(client) as (c: unknown) => Promise<{ Body: { transformToByteArray(): Promise<Uint8Array> } }>;
    const out = await send({ input: { Key: up.objectKey } });
    expect(Buffer.from(await out.Body.transformToByteArray())).toEqual(PNG);
    await expect(send({ input: { Key: 'annotations/none.png' } })).rejects.toMatchObject({ name: 'NoSuchKey' });
  });
});
