// Composition helper for the privacy routes (GET/DELETE /api/v1/privacy/*).
// Wires the Postgres repo, the storage-driver-specific screenshot eraser and
// the use cases, so container.ts only needs one call:
//
//   privacyRoutes: buildPrivacyRouteDeps({ db, config, s3Client, passwordHasher, screenshotStore })

import type { Knex } from 'knex';
import type { S3Client } from '@aws-sdk/client-s3';

import { PgPrivacyRepo } from '../adapters/outbound/postgres/PgPrivacyRepo.js';
import { LocalFsScreenshotEraser, S3ScreenshotEraser } from '../adapters/outbound/privacy/ScreenshotErasers.js';
import { LocalFsScreenshotStore } from '../adapters/outbound/localfs/LocalFsScreenshotStore.js';
import type { PasswordHasher } from '../domain/auth/ports/PasswordHasher.js';
import { EraseAccount } from '../domain/privacy/usecases/eraseAccount.js';
import { EraseOrg } from '../domain/privacy/usecases/eraseOrg.js';
import type { PrivacyRouteDeps } from '../adapters/inbound/http/privacy.routes.js';
import type { ScreenshotEraser } from '../domain/privacy/ports/ScreenshotEraser.js';
import type { Config } from './config.js';

export interface BuildPrivacyDeps {
  db: Knex;
  config: Pick<Config, 'storage' | 's3'>;
  s3Client: Pick<S3Client, 'send'>;
  passwordHasher: PasswordHasher;
  /** The wired screenshot store; a LocalFsScreenshotStore selects the disk eraser. */
  screenshotStore: object;
}

/** The eraser matching the wired storage driver (disk for the local store, S3 otherwise). */
export function pickScreenshotEraser(d: Pick<BuildPrivacyDeps, 'screenshotStore' | 's3Client' | 'config'>): ScreenshotEraser {
  return d.screenshotStore instanceof LocalFsScreenshotStore
    ? new LocalFsScreenshotEraser(d.screenshotStore)
    : new S3ScreenshotEraser(d.s3Client, d.config.s3.bucket);
}

export function buildPrivacyRouteDeps(d: BuildPrivacyDeps): Omit<PrivacyRouteDeps, 'authMiddleware'> {
  const repo = new PgPrivacyRepo(d.db);
  const screenshotEraser = pickScreenshotEraser(d);
  const deps = { repo, passwordHasher: d.passwordHasher, screenshotEraser };
  return {
    db: d.db,
    repo,
    eraseAccount: new EraseAccount(deps),
    eraseOrg: new EraseOrg(deps),
  };
}
