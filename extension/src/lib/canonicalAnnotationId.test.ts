import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetCanonicalAnnotationIdsForTests,
  awaitCanonicalAnnotationId,
  resolveCanonicalAnnotationId,
} from './canonicalAnnotationId';

describe('canonicalAnnotationId', () => {
  afterEach(() => {
    __resetCanonicalAnnotationIdsForTests();
    vi.useRealTimers();
  });

  it('resolves a waiter when the Syncer reports the server id', async () => {
    const p = awaitCanonicalAnnotationId('local-1', 5_000);
    resolveCanonicalAnnotationId('local-1', 'server-1');
    await expect(p).resolves.toBe('server-1');
  });

  it('resolves immediately when the mapping is already known', async () => {
    resolveCanonicalAnnotationId('local-2', 'server-2');
    await expect(awaitCanonicalAnnotationId('local-2', 10)).resolves.toBe('server-2');
  });

  it('resolves null after the timeout', async () => {
    vi.useFakeTimers();
    const p = awaitCanonicalAnnotationId('local-3', 1_000);
    vi.advanceTimersByTime(1_001);
    await expect(p).resolves.toBeNull();
    // A late resolution does not throw.
    expect(() => resolveCanonicalAnnotationId('local-3', 'server-3')).not.toThrow();
  });
});
