// Feature: pinpoint-app, Task 25.8 — Screenshot capture integration test
// **Validates: Requirements 34.1, 34.3, 34.4**
//
// End-to-end flow under test (rewired against the hex inbound + use case):
//   1. Authenticated client creates a project + page + annotation through
//      the hex `projectAnnotationsRouter` (Req 23.2 / 24.1).
//   2. Client posts a PNG bitmap to `/api/v1/annotations/:id/screenshot`
//      as `multipart/form-data` (Req 34.1, 34.3 — task 25.5).
//   3. The route pipes the bytes through the `attachScreenshot` use case,
//      which persists them via the `FakeScreenshotStore` and stamps
//      `annotations.screenshot_object_key` in real Postgres through the
//      `PgAnnotationRepo` adapter.
//   4. The response carries `{ screenshotObjectKey, screenshotUrl }`.
//   5. A subsequent fetch of the project's annotations surfaces the
//      populated `screenshotObjectKey` field so the detail view (extension
//      popover + dashboard project view) can render the image (Req 34.4).
//
// The test exercises the real Postgres adapters so the
// `screenshot_object_key TEXT NULL` column added by migration
// `20240215000000_annotations_screenshot_object_key` is actually
// round-tripped through pg / knex. The S3 PutObject is replaced with the
// in-memory `FakeScreenshotStore` so the test does not need an S3
// container — same substitution shape the legacy version used, now
// routed through the proper `ScreenshotStore` port.
//
// Skips gracefully when no Postgres test DB is available so this test
// can run in `npm test` locally without a database container.

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import knex, { Knex } from 'knex';
import crypto from 'crypto';
import path from 'path';

import { createAnnotationRoutes } from '../../adapters/inbound/http/index.js';
import { createAuthMiddleware } from '../../adapters/inbound/http/auth.middleware.js';
import { JwtTokenIssuer } from '../../adapters/outbound/jwt/JwtTokenIssuer.js';
import { PgAnnotationRepo } from '../../adapters/outbound/postgres/PgAnnotationRepo.js';
import { PgPageRepo } from '../../adapters/outbound/postgres/PgPageRepo.js';
import { PgProjectRepo } from '../../adapters/outbound/postgres/PgProjectRepo.js';
import { PgProjectPinSequence } from '../../adapters/outbound/postgres/PgProjectPinSequence.js';
import { PgTeamMemberRepo } from '../../adapters/outbound/postgres/PgTeamMemberRepo.js';
import { SystemClock } from '../../adapters/outbound/clock/SystemClock.js';
import { CreateAnnotation } from '../../domain/annotation/usecases/createAnnotation.js';
import { UpdateAnnotation } from '../../domain/annotation/usecases/updateAnnotation.js';
import { ChangeAnnotationStatus } from '../../domain/annotation/usecases/changeAnnotationStatus.js';
import { DeleteAnnotation } from '../../domain/annotation/usecases/deleteAnnotation.js';
import { AttachScreenshot } from '../../domain/annotation/usecases/attachScreenshot.js';
import { FakeScreenshotStore } from '../fakes/index.js';

// Resolve migrations relative to the server workspace so the suite runs
// identically from the repo root and from `server/`.
const SERVER_ROOT = path.resolve(__dirname, '..', '..', '..');
const migrationsDir = path.join(SERVER_ROOT, 'src', 'migrations');

function buildKnexConfig(): Knex.Config {
  return {
    client: 'pg',
    connection: {
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME || 'pinpoint_test',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
    },
    pool: { min: 1, max: 4 },
    migrations: {
      directory: migrationsDir,
      extension: 'ts',
    },
  };
}

// A minimal valid PNG header — enough to round-trip through multer's
// `image/png` validator without pulling in an image generator. The S3
// upload is faked, so the bytes don't have to be a renderable image.
const TINY_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature
  0x00, 0x00, 0x00, 0x0d, // IHDR length
  0x49, 0x48, 0x44, 0x52, // 'IHDR'
  0x00, 0x00, 0x00, 0x01, // width = 1
  0x00, 0x00, 0x00, 0x01, // height = 1
  0x08, 0x06, 0x00, 0x00, 0x00, // bit depth + color type + misc
]);

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

let dbAvailable = false;
let db: Knex | null = null;
let setupError: string | null = null;
const seededProjectIds: string[] = [];
const seededUserIds: string[] = [];

describe('Integration: screenshot capture (Task 25.8 — Requirements 34.1, 34.3, 34.4)', () => {
  beforeAll(async () => {
    if (process.env.SKIP_INTEGRATION_TESTS === 'true') {
      setupError = 'SKIP_INTEGRATION_TESTS=true';
      return;
    }
    try {
      db = knex(buildKnexConfig());
      // Lightweight readiness probe; fails fast when there's no DB.
      await db.raw('SELECT 1');
      // Idempotent — a no-op on an already-migrated DB. Ensures the
      // `screenshot_object_key` column from migration
      // 20240215000000_annotations_screenshot_object_key is present.
      await db.migrate.latest();
      dbAvailable = true;
    } catch (err) {
      setupError = err instanceof Error ? err.message : String(err);
      if (db) {
        await db.destroy().catch(() => {});
        db = null;
      }
      dbAvailable = false;
    }
  }, 30_000);

  afterAll(async () => {
    if (!db) return;
    try {
      // Cascading FKs clean up annotations + pages when we delete the
      // project; the user delete sweeps remaining ownership.
      if (seededProjectIds.length > 0) {
        await db('projects').whereIn('id', seededProjectIds).del();
      }
      if (seededUserIds.length > 0) {
        await db('users').whereIn('id', seededUserIds).del();
      }
    } catch {
      // best-effort cleanup; never fail the suite on teardown
    } finally {
      await db.destroy().catch(() => {});
      db = null;
    }
  });

  it('uploads a PNG → screenshot store receives bytes → DB row updated → annotation list surfaces screenshotObjectKey', async (ctx) => {
    if (!dbAvailable || !db) {
      ctx.skip(`Postgres test DB unavailable: ${setupError ?? 'unknown'}`);
      return;
    }

    // --- Seed: user owns a fresh project ---
    //
    // We seed user + project directly via knex (rather than going through
    // the auth + project HTTP routes) because this test's focus is the
    // screenshot pipeline, not auth or project creation. A signed JWT for
    // the seeded user authorizes the annotation + screenshot POSTs below.
    const userId = crypto.randomUUID();
    const userEmail = `screenshot-capture-${userId}@test.local`;
    await db('users').insert({
      id: userId,
      email: userEmail,
      name: 'Screenshot Capture Test User',
      password_hash: 'placeholder-hash',
      verified: true,
    });
    seededUserIds.push(userId);

    const projectId = crypto.randomUUID();
    const pageUrl = `https://example.com/screenshot-capture/${projectId}`;
    await db('projects').insert({
      id: projectId,
      name: `screenshot-capture-${projectId}`,
      urls: [pageUrl],
      status: 'active',
      owner_id: userId,
      pin_counter: 0,
    });
    seededProjectIds.push(projectId);

    // --- Construct the hex outbound + use cases ---
    //
    // Real Postgres for everything except `ScreenshotStore`, which is
    // backed by the in-memory fake.
    const clock = new SystemClock();
    const annotationRepo = new PgAnnotationRepo(db);
    const projectRepo = new PgProjectRepo(db);
    const pageRepo = new PgPageRepo(db);
    const teamMemberRepo = new PgTeamMemberRepo(db);
    const pinSequence = new PgProjectPinSequence(db);
    const screenshotStore = new FakeScreenshotStore();

    const eventBusNoop = { emit: (_e: unknown): void => {} };
    const runInTransaction = async <T>(
      fn: (tx: unknown) => Promise<T>,
    ): Promise<T> => db!.transaction((trx) => fn(trx));

    const createAnnotation = new CreateAnnotation({
      annotationRepo,
      projectRepo,
      pageRepo,
      teamMemberRepo,
      pinSequence,
      runInTransaction,
      clock,
      eventBus: eventBusNoop,
    });
    const updateAnnotation = new UpdateAnnotation({
      annotationRepo,
      projectRepo,
      teamMemberRepo,
    });
    const changeAnnotationStatus = new ChangeAnnotationStatus({
      annotationRepo,
      projectRepo,
      teamMemberRepo,
    });
    const deleteAnnotation = new DeleteAnnotation({
      annotationRepo,
      projectRepo,
      teamMemberRepo,
    });
    const attachScreenshot = new AttachScreenshot({
      annotationRepo,
      projectRepo,
      teamMemberRepo,
      screenshotStore,
    });

    // --- Mount the hex routers ---
    const tokenIssuer = new JwtTokenIssuer({ secret: JWT_SECRET });
    const authMiddleware = createAuthMiddleware({ tokenIssuer });
    const { projectAnnotationsRouter, annotationRouter } = createAnnotationRoutes({
      createAnnotation,
      updateAnnotation,
      changeAnnotationStatus,
      deleteAnnotation,
      attachScreenshot,
      annotationRepo,
      resolvePageUrls: async (annotations, projId) => {
        const map = new Map<string, string>();
        if (annotations.length === 0) return map;
        const pages = await pageRepo.listByProject(projId);
        for (const p of pages) map.set(p.id, p.url);
        return map;
      },
      buildScreenshotUrl: (key) => screenshotStore.buildScreenshotUrl(key),
      authMiddleware,
    });

    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/v1/projects/:id/annotations', projectAnnotationsRouter);
    app.use('/api/v1/annotations', annotationRouter);

    const token = tokenIssuer.sign({ userId, email: userEmail, orgId: 'org-test', role: 'owner', tokenVersion: 0 });
    const authHeader = `Bearer ${token}`;

    // ----------------------------------------------------------------
    // Step 1: Create an annotation (auto-creates the page row)
    // ----------------------------------------------------------------
    const createRes = await request(app)
      .post(`/api/v1/projects/${projectId}/annotations`)
      .set('Authorization', authHeader)
      .send({
        type: 'note',
        severity: 'minor',
        body: 'Screenshot capture integration test',
        pageUrl,
        target: {
          cssSelector: 'main > p',
          xpath: '/html/body/main/p',
          pageX: 100,
          pageY: 200,
          tagName: 'P',
          textSnippet: 'Hello world',
        },
        environment: {
          browserFamily: 'Chrome',
          browserVersion: '120',
          osFamily: 'macOS',
          osVersion: '14',
          deviceType: 'desktop',
          userAgentRaw: 'test-ua',
        },
      });

    expect(createRes.status).toBe(201);
    const annotationId = createRes.body?.annotation?.id as string;
    expect(annotationId).toEqual(expect.any(String));
    // Pre-condition: the new row has no screenshot yet.
    expect(createRes.body.annotation.screenshotObjectKey).toBeUndefined();

    // ----------------------------------------------------------------
    // Step 2: POST the screenshot as multipart/form-data.
    //
    // `redactionRects` is supplied as an empty JSON array. The "no rects
    // ⇒ no blur" branch is the path the extension takes when capture is
    // enabled but the user hasn't drawn any redaction boxes.
    // ----------------------------------------------------------------
    const screenshotRes = await request(app)
      .post(`/api/v1/annotations/${annotationId}/screenshot`)
      .set('Authorization', authHeader)
      .attach('image', TINY_PNG, { filename: 'shot.png', contentType: 'image/png' })
      .field('redactionRects', '[]');

    // ----------------------------------------------------------------
    // Step 3: Response is 200 with object key + URL
    // ----------------------------------------------------------------
    expect(screenshotRes.status).toBe(200);
    expect(screenshotRes.body.screenshotObjectKey).toEqual(expect.any(String));
    expect(screenshotRes.body.screenshotObjectKey).toContain(annotationId);
    expect(screenshotRes.body.screenshotUrl).toContain(
      screenshotRes.body.screenshotObjectKey,
    );
    const objectKey = screenshotRes.body.screenshotObjectKey as string;

    // The fake screenshot store received the bytes — proof the upload
    // step ran and the use case handed the buffer to the adapter
    // unchanged. Validates Req 34.3 ("persists to S3") modulo the real
    // network call.
    const stored = screenshotStore.objects.get(objectKey);
    expect(stored).toBeDefined();
    expect(stored!.contentType).toBe('image/png');
    expect(stored!.body.equals(TINY_PNG)).toBe(true);

    // ----------------------------------------------------------------
    // Step 4: The `annotations.screenshot_object_key` column reflects
    //         the new key in real Postgres.
    // ----------------------------------------------------------------
    const dbRow = await db!('annotations').where({ id: annotationId }).first();
    expect(dbRow).toBeDefined();
    expect(dbRow.screenshot_object_key).toBe(objectKey);

    // ----------------------------------------------------------------
    // Step 5: Fetching the annotation list (the read path that backs
    //         the dashboard project view + extension sidebar) returns
    //         the annotation with `screenshotObjectKey` populated, so
    //         the detail view (`<img src=…>`) has everything it needs
    //         to render the image (Req 34.4 / task 25.6).
    // ----------------------------------------------------------------
    const listRes = await request(app)
      .get(`/api/v1/projects/${projectId}/annotations`)
      .set('Authorization', authHeader);

    expect(listRes.status).toBe(200);
    const fetched = (listRes.body.annotations as Array<Record<string, unknown>>).find(
      (a) => a.id === annotationId,
    );
    expect(fetched).toBeDefined();
    expect(fetched!.screenshotObjectKey).toBe(objectKey);
    // Sanity check: the page reference round-trips through the read path so
    // the detail view can resolve the URL alongside the screenshot.
    expect(fetched!.pageUrl).toBe(pageUrl);
  }, 60_000);
});
