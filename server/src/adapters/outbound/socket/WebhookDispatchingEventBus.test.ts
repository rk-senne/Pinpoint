import { describe, it, expect, vi } from 'vitest';

import { WebhookDispatchingEventBus } from './WebhookDispatchingEventBus.js';

/**
 * Regression test for INCONSISTENCIES.md #5 — webhooks never dispatched.
 *
 * The bus previously read `payload.orgId` directly and skipped every event
 * that lacked it. All annotation/comment domain events are project-scoped and
 * omit orgId, so no webhook ever fired. These tests lock in the fix: orgId is
 * resolved from the payload's projectId via a projects.org_id lookup.
 */

/** Flush the fire-and-forget microtask chain kicked off by emit(). */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeBus(projectOrgRow: { org_id?: string } | undefined) {
  const primary = { emit: vi.fn() };
  const dispatchWebhook = { execute: vi.fn().mockResolvedValue(undefined) };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const first = vi.fn().mockResolvedValue(projectOrgRow);
  const where = vi.fn(() => ({ first }));
  const insert = vi.fn().mockResolvedValue([1]);
  const db = vi.fn((table: string) =>
    table === 'projects' ? { where } : { insert },
  );
  const bus = new WebhookDispatchingEventBus(
    primary as never,
    dispatchWebhook as never,
    logger as never,
    db as never,
  );
  return { bus, primary, dispatchWebhook, logger, where, first };
}

describe('WebhookDispatchingEventBus', () => {
  it('resolves orgId from projectId and dispatches when payload lacks orgId', async () => {
    const { bus, dispatchWebhook, primary } = makeBus({ org_id: 'org-123' });

    bus.emit({
      type: 'annotation.created',
      room: 'project:p1',
      payload: { id: 'a1', projectId: 'p1' },
    } as never);
    await flush();

    expect(primary.emit).toHaveBeenCalledOnce();
    expect(dispatchWebhook.execute).toHaveBeenCalledWith({
      orgId: 'org-123',
      eventType: 'annotation.created',
      payload: { id: 'a1', projectId: 'p1' },
    });
  });

  it('uses orgId directly from the payload without a projects lookup', async () => {
    const { bus, dispatchWebhook, where } = makeBus(undefined);

    bus.emit({
      type: 'comment.created',
      room: 'annotation:an1',
      payload: {
        orgId: 'org-9',
        projectId: 'p1',
        annotationId: 'an1',
        comment: { id: 'c1', authorId: 'u1' },
      },
    } as never);
    await flush();

    expect(where).not.toHaveBeenCalled(); // no DB lookup needed
    expect(dispatchWebhook.execute).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-9', eventType: 'comment.created' }),
    );
  });

  it('skips dispatch and warns when orgId cannot be resolved', async () => {
    const { bus, dispatchWebhook, logger } = makeBus(undefined); // project has no org

    bus.emit({
      type: 'annotation.created',
      room: 'project:pX',
      payload: { id: 'a1', projectId: 'pX' },
    } as never);
    await flush();

    expect(dispatchWebhook.execute).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('does not dispatch webhooks for non-webhook event types', async () => {
    const { bus, dispatchWebhook, primary } = makeBus({ org_id: 'org-1' });

    bus.emit({
      type: 'user.notification.created',
      room: 'user:1',
      payload: { projectId: 'p1' },
    } as never);
    await flush();

    expect(primary.emit).toHaveBeenCalledOnce();
    expect(dispatchWebhook.execute).not.toHaveBeenCalled();
  });
});
