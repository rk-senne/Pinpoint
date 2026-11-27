import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createPlanLimitsMiddleware } from './planLimits.js';

type Rows = { organizations?: Record<string, unknown> | undefined; usage_records?: Record<string, unknown> | undefined; projects?: number; memberships?: number; throws?: boolean };

function fakeDb(rows: Rows) {
  return ((table: string) => {
    if (rows.throws) throw new Error('db down');
    const chain = {
      where: () => chain,
      first: async () => (table === 'organizations' ? rows.organizations : rows.usage_records),
      count: async () => [{ count: table === 'projects' ? rows.projects ?? 0 : rows.memberships ?? 0 }],
    };
    return chain;
  }) as never;
}

function run(db: unknown, kind: 'annotations' | 'projects' | 'seats', user: { orgId: string } | undefined = { orgId: 'o1' }) {
  const headers: Record<string, string> = {};
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis(), setHeader: (k: string, v: string) => { headers[k] = v; } } as unknown as Response;
  const next = vi.fn();
  return createPlanLimitsMiddleware(db as never, kind)({ user } as Request, res, next).then(() => ({ res, next, headers }));
}

describe('createPlanLimitsMiddleware', () => {
  it('passes through when unauthenticated or the org is missing', async () => {
    expect((await run(fakeDb({}), 'projects', undefined)).next).toHaveBeenCalled();
    expect((await run(fakeDb({ organizations: undefined }), 'projects')).next).toHaveBeenCalled();
  });

  it('blocks the free plan at the project limit with 402 PLAN_LIMIT_EXCEEDED, allows below it', async () => {
    const blocked = await run(fakeDb({ organizations: { plan: 'free' }, projects: 2 }), 'projects');
    expect(blocked.next).not.toHaveBeenCalled();
    expect(blocked.res.status).toHaveBeenCalledWith(402);
    expect((blocked.res.json as ReturnType<typeof vi.fn>).mock.calls[0]![0].error.code).toBe('PLAN_LIMIT_EXCEEDED');
    expect((await run(fakeDb({ organizations: { plan: 'free' }, projects: 1 }), 'projects')).next).toHaveBeenCalled();
  });

  it('blocks the free plan at 50 annotations/month; pro is unlimited', async () => {
    const blocked = await run(fakeDb({ organizations: { plan: 'free' }, usage_records: { annotations_count: 50 } }), 'annotations');
    expect(blocked.res.status).toHaveBeenCalledWith(402);
    expect((await run(fakeDb({ organizations: { plan: 'free' }, usage_records: { annotations_count: 49 } }), 'annotations')).next).toHaveBeenCalled();
    expect((await run(fakeDb({ organizations: { plan: 'free' } }), 'annotations')).next).toHaveBeenCalled();
    expect((await run(fakeDb({ organizations: { plan: 'pro' }, usage_records: { annotations_count: 9999 } }), 'annotations')).next).toHaveBeenCalled();
  });

  it('enforces seat limits (free = 2, pro = 10, enterprise unlimited) and defaults unknown plans to free', async () => {
    expect((await run(fakeDb({ organizations: { plan: 'free' }, memberships: 2 }), 'seats')).res.status).toHaveBeenCalledWith(402);
    expect((await run(fakeDb({ organizations: { plan: 'pro' }, memberships: 9 }), 'seats')).next).toHaveBeenCalled();
    expect((await run(fakeDb({ organizations: { plan: 'pro' }, memberships: 10 }), 'seats')).res.status).toHaveBeenCalledWith(402);
    expect((await run(fakeDb({ organizations: { plan: 'enterprise' }, memberships: 500 }), 'seats')).next).toHaveBeenCalled();
    expect((await run(fakeDb({ organizations: { plan: 'mystery' }, projects: 2 }), 'projects')).res.status).toHaveBeenCalledWith(402);
  });

  it('advertises the grace period via X-Grace-Period-Ends without blocking', async () => {
    const r = await run(fakeDb({ organizations: { plan: 'pro', grace_period_ends_at: '2026-12-01T00:00:00.000Z' }, projects: 0 }), 'projects');
    expect(r.headers['X-Grace-Period-Ends']).toBe('2026-12-01T00:00:00.000Z');
    expect(r.next).toHaveBeenCalled();
  });

  it('fails open when the database throws', async () => {
    expect((await run(fakeDb({ throws: true }), 'projects')).next).toHaveBeenCalled();
  });
});
