import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { LocalFsScreenshotStore } from '../localfs/LocalFsScreenshotStore.js';
import { LocalFsScreenshotEraser, S3ScreenshotEraser } from './ScreenshotErasers.js';

const dir = mkdtempSync(path.join(tmpdir(), 'pp-eraser-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('LocalFsScreenshotEraser', () => {
  const store = new LocalFsScreenshotStore({ dir, signingSecret: 's'.repeat(32), publicBaseUrl: 'http://x' });
  it('deletes the PNG and its markup sibling, tolerates missing files, rejects path traversal', async () => {
    const key = 'annotations/screenshots/a1/x.png';
    const abs = store.resolveKeyPath(key);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, 'png');
    writeFileSync(`${abs}.markup.json`, '{}');
    const r = await new LocalFsScreenshotEraser(store).deleteScreenshots([key, 'annotations/screenshots/none/missing.png', '../../etc/passwd']);
    expect(existsSync(abs)).toBe(false);
    expect(existsSync(`${abs}.markup.json`)).toBe(false);
    expect(r.deleted).toBe(2);
    expect(r.failed).toEqual(['../../etc/passwd']);
  });
});

describe('S3ScreenshotEraser', () => {
  it('batch-deletes PNG + markup keys (≤1000 per request) and reports per-key failures', async () => {
    const send = vi.fn(async (cmd: { input: { Delete: { Objects: Array<{ Key: string }> } } }) => ({
      Errors: cmd.input.Delete.Objects.filter((o) => o.Key === 'bad.png').map((o) => ({ Key: o.Key })),
    }));
    const keys = Array.from({ length: 700 }, (_, i) => `k/${i}.png`).concat('bad.png');
    const r = await new S3ScreenshotEraser({ send } as never, 'bucket').deleteScreenshots(keys);
    expect(send).toHaveBeenCalledTimes(2); // 701 keys × 2 objects = 1402
    expect(r.failed).toEqual(['bad.png']);
    expect(r.deleted).toBe(700);
  });

  it('treats a failed request as failed keys instead of throwing', async () => {
    const send = vi.fn(async () => { throw new Error('boom'); });
    const r = await new S3ScreenshotEraser({ send } as never, 'b').deleteScreenshots(['a.png']);
    expect(r).toEqual({ deleted: 0, failed: ['a.png'] });
  });
});
