import { describe, it, expect } from 'vitest';
import { loadConfigFromEnv, resolveStorageDriver } from './config.js';

describe('resolveStorageDriver', () => {
  it('defaults to local when no S3 endpoint / AWS credentials are present', () => {
    expect(resolveStorageDriver({})).toBe('local');
    expect(resolveStorageDriver({ S3_BUCKET: 'x', AWS_REGION: 'eu-west-1' })).toBe('local');
  });
  it('defaults to s3 when S3_ENDPOINT or AWS_ACCESS_KEY_ID is set', () => {
    expect(resolveStorageDriver({ S3_ENDPOINT: 'http://minio:9000' })).toBe('s3');
    expect(resolveStorageDriver({ AWS_ACCESS_KEY_ID: 'AKIA' })).toBe('s3');
  });
  it('honours an explicit STORAGE_DRIVER (case-insensitive) over the heuristics', () => {
    expect(resolveStorageDriver({ STORAGE_DRIVER: 'local', S3_ENDPOINT: 'http://m' })).toBe('local');
    expect(resolveStorageDriver({ STORAGE_DRIVER: 'S3' })).toBe('s3');
  });
  it('loadConfigFromEnv exposes the driver and directory', () => {
    expect(loadConfigFromEnv({}).storage).toEqual({ driver: 'local', localDir: './var/screenshots' });
    expect(loadConfigFromEnv({ LOCAL_STORAGE_DIR: '/data/screenshots' }).storage.localDir).toBe('/data/screenshots');
  });
});
