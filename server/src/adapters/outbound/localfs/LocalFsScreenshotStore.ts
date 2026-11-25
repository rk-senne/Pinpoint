// LocalFsScreenshotStore — outbound adapter for the `ScreenshotStore` port
// that persists screenshots (and their sibling Markup_Document JSON) on the
// local disk, so a self-hosted deployment needs no S3 provider.
//
// Security notes:
//   * Object keys are sanitised: only `[A-Za-z0-9._-]` path segments, no `.`/
//     `..`/empty segments, no absolute paths, no NUL/backslash; the resolved
//     path must additionally stay inside the storage root.
//   * Writes are atomic (temp file in the same directory + rename), files are
//     created 0600 and directories 0700.
//   * Browsers never see a disk path. `presignScreenshotUrl` returns a
//     short-lived HMAC-signed URL served by `GET /api/v1/screenshots/:token`
//     (see `screenshotTokenRoutes.ts`); the signing key is derived from the
//     JWT secret with a domain-separation label.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  StorageUnavailableError,
  type ScreenshotStore,
  type UploadMarkupInput,
  type UploadMarkupResult,
  type UploadScreenshotInput,
  type UploadScreenshotResult,
} from '../../../domain/annotation/ports/ScreenshotStore.js';

export interface LocalFsScreenshotStoreConfig {
  /** Root directory screenshots are stored under. Created (0700) on first write. */
  dir: string;
  /** Secret the URL-signing key is derived from (the JWT secret). */
  signingSecret: string;
  /** Public origin of the API/dashboard, e.g. `https://feedback.example.com`. */
  publicBaseUrl: string;
  /** Object-key prefix. Defaults to `annotations/screenshots`. */
  keyPrefix?: string;
  /** Injectable clock (ms since epoch) for tests. */
  now?: () => number;
}

const DEFAULT_KEY_PREFIX = 'annotations/screenshots';
const MARKUP_KEY_SUFFIX = '.markup.json';
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_KEY_LENGTH = 512;
export const SCREENSHOT_URL_TTL_SECONDS = 900;

/** Thrown for a key that is not a safe relative object key. */
export class InvalidStorageKeyError extends Error {
  readonly name = 'InvalidStorageKeyError';
}

/** Derive the URL-signing key from the JWT secret (domain separated). */
export function deriveScreenshotSigningKey(jwtSecret: string): Buffer {
  return createHmac('sha256', jwtSecret).update('pinpoint:screenshot-url:v1').digest();
}

/**
 * Returns the key when it is a safe relative object key, otherwise throws.
 * Exported for tests and for the token route.
 */
export function assertSafeKey(key: string): string {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH) {
    throw new InvalidStorageKeyError('Invalid storage key.');
  }
  // Everything outside the allow-list (NUL, backslash, `%`, spaces, unicode
  // lookalikes, leading `/`) fails the segment regex below.
  const segments = key.split('/');
  for (const seg of segments) {
    if (!SEGMENT_RE.test(seg) || seg === '.' || seg === '..' || seg.includes('..')) {
      throw new InvalidStorageKeyError('Invalid storage key.');
    }
  }
  return key;
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}

export class LocalFsScreenshotStore implements ScreenshotStore {
  private readonly root: string;
  private readonly signingKey: Buffer;
  private readonly now: () => number;

  constructor(private readonly config: LocalFsScreenshotStoreConfig) {
    this.root = path.resolve(config.dir);
    this.signingKey = deriveScreenshotSigningKey(config.signingSecret);
    this.now = config.now ?? Date.now;
  }

  // ---- ScreenshotStore port ---------------------------------------------

  async uploadScreenshot(input: UploadScreenshotInput): Promise<UploadScreenshotResult> {
    const prefix = this.config.keyPrefix ?? DEFAULT_KEY_PREFIX;
    const objectKey = assertSafeKey(
      `${prefix}/${input.annotationId}/${randomBytes(8).toString('hex')}.png`,
    );
    await this.writeAtomic(objectKey, input.body);
    return { objectKey, url: this.buildScreenshotUrl(objectKey) };
  }

  async uploadMarkupDocument(input: UploadMarkupInput): Promise<UploadMarkupResult> {
    const objectKey = assertSafeKey(`${input.screenshotKey}${MARKUP_KEY_SUFFIX}`);
    await this.writeAtomic(objectKey, Buffer.from(JSON.stringify(input.markupDocument), 'utf8'));
    return { objectKey, url: this.buildScreenshotUrl(objectKey) };
  }

  async fetchScreenshot(objectKey: string): Promise<Buffer | null> {
    return this.readFile(objectKey);
  }

  async fetchMarkupDocument(screenshotKey: string): Promise<unknown | null> {
    const buf = await this.readFile(`${screenshotKey}${MARKUP_KEY_SUFFIX}`);
    if (!buf || buf.length === 0) return null;
    return JSON.parse(buf.toString('utf8'));
  }

  /**
   * A URL valid for 15 minutes that needs no cookies. Same value as
   * `buildScreenshotUrl`: the local store has no "plain" public URL.
   */
  buildScreenshotUrl(objectKey: string): string {
    return this.signedUrl(objectKey, SCREENSHOT_URL_TTL_SECONDS);
  }

  async presignScreenshotUrl(
    objectKey: string,
    expiresInSeconds = SCREENSHOT_URL_TTL_SECONDS,
  ): Promise<string> {
    return this.signedUrl(objectKey, expiresInSeconds);
  }

  // ---- signed URLs --------------------------------------------------------

  signToken(objectKey: string, expiresInSeconds: number): string {
    assertSafeKey(objectKey);
    const exp = Math.floor(this.now() / 1000) + expiresInSeconds;
    const payload = `${b64url(objectKey)}.${exp}`;
    const sig = createHmac('sha256', this.signingKey).update(payload).digest('base64url');
    return `${payload}.${sig}`;
  }

  /**
   * Verifies signature + expiry and returns the object key, or null for any
   * malformed / forged / expired token.
   */
  verifyToken(token: string): string | null {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [encKey, expStr, sig] = parts as [string, string, string];
    if (!/^\d{1,12}$/.test(expStr)) return null;
    const expected = createHmac('sha256', this.signingKey)
      .update(`${encKey}.${expStr}`)
      .digest();
    let given: Buffer;
    try {
      given = Buffer.from(sig, 'base64url');
    } catch {
      return null;
    }
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    if (Number(expStr) < Math.floor(this.now() / 1000)) return null;
    try {
      return assertSafeKey(Buffer.from(encKey, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
  }

  private signedUrl(objectKey: string, ttl: number): string {
    const base = this.config.publicBaseUrl.replace(/\/+$/, '');
    return `${base}/api/v1/screenshots/${this.signToken(objectKey, ttl)}`;
  }

  // ---- filesystem helpers -------------------------------------------------

  /** Absolute path for a key; throws if it would escape the root. */
  resolveKeyPath(objectKey: string): string {
    assertSafeKey(objectKey);
    const abs = path.resolve(this.root, ...objectKey.split('/'));
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) {
      throw new InvalidStorageKeyError('Invalid storage key.');
    }
    return abs;
  }

  private async writeAtomic(objectKey: string, body: Buffer): Promise<void> {
    const target = this.resolveKeyPath(objectKey);
    const dir = path.dirname(target);
    const tmp = path.join(dir, `.tmp-${randomBytes(8).toString('hex')}`);
    try {
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await fs.writeFile(tmp, body, { mode: 0o600, flag: 'wx' });
      await fs.rename(tmp, target);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw mapFsError(err);
    }
  }

  private async readFile(objectKey: string): Promise<Buffer | null> {
    let abs: string;
    try {
      abs = this.resolveKeyPath(objectKey);
    } catch {
      return null; // an unsafe key can never exist
    }
    try {
      return await fs.readFile(abs);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return null;
      throw mapFsError(err);
    }
  }
}

const UNAVAILABLE_FS_CODES = new Set(['EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'EDQUOT', 'EMFILE', 'EIO']);

function mapFsError(err: unknown): unknown {
  if (err instanceof StorageUnavailableError || err instanceof InvalidStorageKeyError) return err;
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code && UNAVAILABLE_FS_CODES.has(code)) {
    return new StorageUnavailableError('Screenshot storage is not writable or is full.', err);
  }
  return err;
}
