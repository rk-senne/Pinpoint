// Slack delivery: provider (Block Kit, error mapping, permalink), channel
// targets pagination, auto-notify filtering + queue delivery. A fake Slack
// HTTP layer replaces safeFetch — no real Slack is ever contacted.
import { describe, it, expect, vi } from 'vitest';

import { createSlackProvider, escapeSlackMrkdwn, buildSlackMessage, mapSlackError } from './slackProvider.js';
import {
  createSlackAnnotationNotifier,
  createSlackQueueDelivery,
  meetsMinSeverity,
  withSlackAutoNotify,
  SLACK_NOTIFICATION_KIND,
} from './slackNotifier.js';
import { createSlackWiring } from './slackWiring.js';
import { listTargets, TargetsFetchError } from './targets.js';
import { TaskDeliveryError, type TaskInput } from './TaskProvider.js';
import { DispatchPendingNotifications } from '../../domain/notification/usecases/dispatchPendingNotifications.js';
import {
  FakeClock,
  FakeLogger,
  FakeMailer,
  FakeNotificationQueue,
  FakeUserRepo,
} from '../../__tests__/fakes/index.js';

const TASK: TaskInput = {
  title: '[Pinpoint #3] x',
  body: 'Button <b>overlaps</b> footer & more',
  url: 'https://app.test/project/p1?annotation=a1',
  severity: 'Major',
  labels: ['pinpoint', 'major'],
  annotationType: 'note',
  status: 'open',
  pageUrl: 'https://site.test/pricing',
  projectUrl: 'https://app.test/projects/p1',
  pinNumber: 3,
};

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });

/** Fake Slack: routes by Web API method name. */
function fakeSlack(handlers: Record<string, (url: URL, init: RequestInit) => Response>) {
  const calls: Array<{ method: string; url: URL; init: RequestInit }> = [];
  const safeFetch = vi.fn(async (u: string, init: RequestInit = {}) => {
    const url = new URL(u);
    expect(url.origin).toBe('https://slack.com');
    const method = url.pathname.replace('/api/', '');
    calls.push({ method, url, init });
    const h = handlers[method];
    if (!h) throw new Error(`unexpected slack call ${method}`);
    return h(url, init);
  }) as any;
  return { safeFetch, calls };
}

const CTX = { accessToken: 'xoxb-secret', config: { channelId: 'C0123', channelName: 'feedback' } };

describe('mrkdwn escaping', () => {
  it('escapes & < > only', () => {
    expect(escapeSlackMrkdwn('a & b <!channel> <@U1> "q"')).toBe('a &amp; b &lt;!channel&gt; &lt;@U1&gt; "q"');
  });

  it('never lets annotation text inject mentions/links into blocks', () => {
    const { blocks, text } = buildSlackMessage({ ...TASK, body: '<!channel> <https://evil.test|click>' });
    const dump = JSON.stringify(blocks) + text;
    expect(dump).not.toContain('<!channel>');
    expect(dump).not.toContain('<https://evil.test|click>');
    expect(dump).toContain('&lt;!channel&gt;');
  });

  it('renders severity, type, status, page and the Pinpoint link', () => {
    const { blocks } = buildSlackMessage(TASK);
    const dump = JSON.stringify(blocks);
    expect(dump).toContain('Major');
    expect(dump).toContain('note');
    expect(dump).toContain('open');
    expect(dump).toContain('<https://site.test/pricing|https://site.test/pricing>');
    expect(dump).toContain('<https://app.test/projects/p1|Open in Pinpoint>');
    expect(dump).toContain('Button &lt;b&gt;overlaps&lt;/b&gt; footer &amp; more');
  });

  it('refuses non-http(s) page URLs and neutralises link-breaking characters', () => {
    const { blocks } = buildSlackMessage({ ...TASK, pageUrl: 'javascript:alert(1)', projectUrl: 'https://a.test/x|y>z' });
    const dump = JSON.stringify(blocks);
    expect(dump).not.toContain('javascript:');
    expect(dump).toContain('<https://a.test/x%7Cy%3Ez|Open in Pinpoint>');
  });

  it('truncates very long bodies under the Slack section limit', () => {
    const { blocks } = buildSlackMessage({ ...TASK, body: 'x'.repeat(10_000) });
    const section = (blocks as any[]).find((b) => b.type === 'section' && b.text);
    expect(section.text.text.length).toBeLessThanOrEqual(3000);
  });
});

describe('Slack provider delivery', () => {
  it('posts via chat.postMessage with bearer auth, then returns the permalink', async () => {
    const slack = fakeSlack({
      'chat.postMessage': () => json({ ok: true, channel: 'C0123', ts: '1700000000.000100' }),
      'chat.getPermalink': () => json({ ok: true, permalink: 'https://acme.slack.com/archives/C0123/p1700000000000100' }),
    });
    const result = await createSlackProvider({ safeFetch: slack.safeFetch }).createTask(CTX, TASK);

    expect(result).toEqual({
      externalId: 'C0123:1700000000.000100',
      externalUrl: 'https://acme.slack.com/archives/C0123/p1700000000000100',
    });
    const post = slack.calls[0]!;
    expect(post.method).toBe('chat.postMessage');
    expect((post.init.headers as any).Authorization).toBe('Bearer xoxb-secret');
    const body = JSON.parse(post.init.body as string);
    expect(body.channel).toBe('C0123');
    expect(body.blocks.length).toBeGreaterThan(2);
    expect(body.unfurl_links).toBe(false);
    const perma = slack.calls[1]!;
    expect(perma.url.searchParams.get('channel')).toBe('C0123');
    expect(perma.url.searchParams.get('message_ts')).toBe('1700000000.000100');
  });

  it('a permalink failure does not fail (or repeat) the delivery', async () => {
    const slack = fakeSlack({
      'chat.postMessage': () => json({ ok: true, channel: 'C0123', ts: '1.2' }),
      'chat.getPermalink': () => json({ ok: false, error: 'internal_error' }),
    });
    const result = await createSlackProvider({ safeFetch: slack.safeFetch }).createTask(CTX, TASK);
    expect(result.externalId).toBe('C0123:1.2');
    expect(result.externalUrl).toContain('slack.com/app_redirect?channel=C0123&message_ts=1.2');
    expect(slack.calls.filter((c) => c.method === 'chat.postMessage')).toHaveLength(1);
  });

  it('requires a channel in config (permanent, no request)', async () => {
    const slack = fakeSlack({});
    await expect(
      createSlackProvider({ safeFetch: slack.safeFetch }).createTask({ accessToken: 't', config: {} }, TASK),
    ).rejects.toMatchObject({ transient: false });
    expect(slack.safeFetch).not.toHaveBeenCalled();
  });

  it('channel_not_found → permanent, tells the admin to pick again', async () => {
    const slack = fakeSlack({ 'chat.postMessage': () => json({ ok: false, error: 'channel_not_found' }) });
    const err = await createSlackProvider({ safeFetch: slack.safeFetch }).createTask(CTX, TASK).catch((e) => e);
    expect(err).toBeInstanceOf(TaskDeliveryError);
    expect(err.transient).toBe(false);
    expect(err.message).toMatch(/#feedback.*not found/i);
  });

  it('not_in_channel → permanent, "invite the bot to the channel"', async () => {
    const slack = fakeSlack({ 'chat.postMessage': () => json({ ok: false, error: 'not_in_channel' }) });
    const err = await createSlackProvider({ safeFetch: slack.safeFetch }).createTask(CTX, TASK).catch((e) => e);
    expect(err.transient).toBe(false);
    expect(err.message).toMatch(/invite/i);
    expect(err.message).toContain('#feedback');
  });

  it('HTTP 429 → transient with Retry-After', async () => {
    const slack = fakeSlack({ 'chat.postMessage': () => json({ ok: false, error: 'ratelimited' }, 429, { 'retry-after': '42' }) });
    const err = await createSlackProvider({ safeFetch: slack.safeFetch }).createTask(CTX, TASK).catch((e) => e);
    expect(err).toMatchObject({ transient: true, status: 429, retryAfterSeconds: 42 });
    expect(err.message).toMatch(/42s/);
  });

  it('5xx and network errors are transient; unknown ok:false is permanent', async () => {
    const p5 = createSlackProvider({ safeFetch: fakeSlack({ 'chat.postMessage': () => json({}, 503) }).safeFetch });
    await expect(p5.createTask(CTX, TASK)).rejects.toMatchObject({ transient: true, status: 503 });
    const net = createSlackProvider({ safeFetch: (async () => { throw new Error('ECONNRESET'); }) as any });
    await expect(net.createTask(CTX, TASK)).rejects.toMatchObject({ transient: true });
    const odd = createSlackProvider({ safeFetch: fakeSlack({ 'chat.postMessage': () => json({ ok: false, error: 'weird' }) }).safeFetch });
    await expect(odd.createTask(CTX, TASK)).rejects.toMatchObject({ transient: false });
  });

  it('never leaks the token in errors', async () => {
    const slack = fakeSlack({ 'chat.postMessage': () => json({ ok: false, error: 'invalid_auth' }) });
    const err = await createSlackProvider({ safeFetch: slack.safeFetch }).createTask(CTX, TASK).catch((e) => e);
    expect(err.message).not.toContain('xoxb-secret');
    expect(err.message).toMatch(/Reconnect/);
  });

  it('mapSlackError classifies codes', () => {
    expect(mapSlackError('is_archived', '#x').transient).toBe(false);
    expect(mapSlackError('internal_error', '#x').transient).toBe(true);
    expect(mapSlackError('missing_scope', '#x').message).toMatch(/chat:write/);
  });
});

describe('Slack channel targets', () => {
  const page = (names: string[], next: string, offset = 0) =>
    json({
      ok: true,
      channels: names.map((n, i) => ({ id: `C${String(offset + i).padStart(5, '0')}`, name: n, is_member: i % 2 === 0 })),
      response_metadata: { next_cursor: next },
    });

  it('follows next_cursor, asks for public non-archived channels and sorts member channels first', async () => {
    const slack = fakeSlack({
      'conversations.list': (url) =>
        url.searchParams.get('cursor') === 'p2' ? page(['gamma', 'delta'], '', 2) : page(['alpha', 'beta'], 'p2'),
    });
    const targets = await listTargets('slack', 'xoxb-secret', { safeFetch: slack.safeFetch });
    expect(slack.calls).toHaveLength(2);
    expect(slack.calls[0]!.url.searchParams.get('types')).toBe('public_channel');
    expect(slack.calls[0]!.url.searchParams.get('exclude_archived')).toBe('true');
    expect(slack.calls[1]!.url.searchParams.get('cursor')).toBe('p2');
    expect(targets.map((t) => t.label)).toEqual([
      '#alpha',
      '#gamma',
      '#beta (invite the bot first)',
      '#delta (invite the bot first)',
    ]);
    expect(targets[0]!.config).toEqual({ channelId: 'C00000', channelName: 'alpha' });
  });

  it('caps pagination at ~1000 channels (5 pages of 200)', async () => {
    let n = 0;
    const slack = fakeSlack({
      'conversations.list': () => {
        const names = Array.from({ length: 200 }, (_, i) => `c${n * 200 + i}`);
        const res = page(names, `cursor-${n + 1}`, n * 200);
        n += 1;
        return res;
      },
    });
    const targets = await listTargets('slack', 't', { safeFetch: slack.safeFetch });
    expect(slack.calls).toHaveLength(5);
    expect(targets).toHaveLength(1000);
  });

  it('maps missing_scope / auth / 429 failures to TargetsFetchError', async () => {
    const run = (res: () => Response) => listTargets('slack', 't', { safeFetch: (async () => res()) as any });
    await expect(run(() => json({ ok: false, error: 'missing_scope' }))).rejects.toThrow(/channels:read/);
    await expect(run(() => json({ ok: false, error: 'invalid_auth' }))).rejects.toMatchObject({ status: 401 });
    await expect(run(() => json({}, 429))).rejects.toMatchObject({ status: 429 });
    await expect(run(() => json({ ok: false, error: 'weird' }))).rejects.toBeInstanceOf(TargetsFetchError);
  });
});

describe('severity threshold', () => {
  it('compares at/above, defaulting to major', () => {
    expect(meetsMinSeverity('critical', 'major')).toBe(true);
    expect(meetsMinSeverity('major', 'major')).toBe(true);
    expect(meetsMinSeverity('minor', 'major')).toBe(false);
    expect(meetsMinSeverity('informational', 'informational')).toBe(true);
    expect(meetsMinSeverity('major', undefined)).toBe(true);
    expect(meetsMinSeverity('minor', 'bogus')).toBe(false);
    expect(meetsMinSeverity('nonsense', 'minor')).toBe(false);
  });
});

function fakeIntegrationRepo(config: Record<string, unknown> | null, over: Record<string, unknown> = {}) {
  return {
    findByOrgAndProvider: vi.fn(async (_o: string, p: string) =>
      config && p === 'slack'
        ? { id: 'i1', orgId: 'org-1', provider: 'slack', accessToken: 'xoxb-secret', config, enabled: true, createdAt: '', ...over }
        : null,
    ),
  } as any;
}

describe('auto-notify', () => {
  function sut(config: Record<string, unknown> | null, over: Record<string, unknown> = {}) {
    const queue = { enqueue: vi.fn(async (_p: unknown, _d: Date) => 'n1') };
    const logger = new FakeLogger();
    const notifier = createSlackAnnotationNotifier({
      db: (() => ({ where: () => ({ first: async () => ({ org_id: 'org-1' }) }) })) as any,
      integrationRepo: fakeIntegrationRepo(config, over),
      notificationQueue: queue,
      logger,
      now: () => new Date('2024-06-01T00:00:00Z'),
    });
    return { notifier, queue, logger };
  }
  const ann = (severity: string, extra: Record<string, unknown> = {}) => ({
    id: 'a1', projectId: 'p1', orgId: 'org-1', severity, type: 'note', status: 'open', body: 'hi', pinNumber: 4, pageUrl: 'https://s.test/', ...extra,
  });
  const ON = { channelId: 'C1', notifyOnNew: true };

  it('enqueues a durable slack_annotation job at/above minSeverity (default major)', async () => {
    const { notifier, queue } = sut(ON);
    await notifier.onAnnotationCreated(ann('critical'));
    await notifier.onAnnotationCreated(ann('major'));
    await notifier.onAnnotationCreated(ann('minor'));
    await notifier.onAnnotationCreated(ann('informational'));
    expect(queue.enqueue).toHaveBeenCalledTimes(2);
    expect(queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ kind: SLACK_NOTIFICATION_KIND, annotationId: 'a1', projectId: 'p1', orgId: 'org-1', severity: 'critical', pinNumber: 4 }),
      new Date('2024-06-01T00:00:00Z'),
    );
  });

  it('honours a custom minSeverity', async () => {
    const { notifier, queue } = sut({ ...ON, minSeverity: 'minor' });
    await notifier.onAnnotationCreated(ann('minor'));
    await notifier.onAnnotationCreated(ann('informational'));
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['notifyOnNew off', { channelId: 'C1', notifyOnNew: false }],
    ['notifyOnNew missing', { channelId: 'C1' }],
    ['no channel', { notifyOnNew: true }],
    ['not connected', null],
  ])('does nothing when %s', async (_n, cfg) => {
    const { notifier, queue } = sut(cfg as any);
    await notifier.onAnnotationCreated(ann('critical'));
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('does nothing when the integration is disabled', async () => {
    const { notifier, queue } = sut(ON, { enabled: false });
    await notifier.onAnnotationCreated(ann('critical'));
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('resolves the org from the project when the event has no orgId', async () => {
    const { notifier, queue } = sut(ON);
    await notifier.onAnnotationCreated(ann('critical', { orgId: undefined }));
    expect(queue.enqueue).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org-1' }), expect.any(Date));
  });

  it('never throws: enqueue failures are logged', async () => {
    const { notifier, queue, logger } = sut(ON);
    queue.enqueue.mockRejectedValueOnce(new Error('db down'));
    await expect(notifier.onAnnotationCreated(ann('critical'))).resolves.toBeUndefined();
    await expect(notifier.onAnnotationCreated(null)).resolves.toBeUndefined();
    expect(JSON.stringify(logger)).toContain('db down');
  });

  it('withSlackAutoNotify forwards every event and feeds only annotation.created, detached', () => {
    const bus = { emit: vi.fn() };
    const notifier = { onAnnotationCreated: vi.fn(() => new Promise<void>(() => { /* never resolves */ })) };
    const wrapped = withSlackAutoNotify(bus as any, notifier);
    wrapped.emit({ type: 'annotation.created', room: 'project:p1', payload: ann('major') } as any);
    wrapped.emit({ type: 'comment.created', room: 'project:p1', payload: {} } as any);
    expect(bus.emit).toHaveBeenCalledTimes(2);
    expect(notifier.onAnnotationCreated).toHaveBeenCalledTimes(1); // emit returned despite a hung notifier
  });
});

describe('queue delivery through the notification worker', () => {
  function setup(providerImpl: (...a: any[]) => Promise<any>, existingLink = false) {
    const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
    const queue = new FakeNotificationQueue(clock);
    const inserted: any[] = [];
    const db: any = (table: string) => ({
      where: () => ({ first: async () => (existingLink && table === 'annotation_external_links' ? { id: 'l1' } : undefined) }),
      insert: (row: any) => {
        inserted.push(row);
        return { onConflict: () => ({ merge: async () => undefined }) };
      },
    });
    db.fn = { now: () => 'now' };
    const provider = { provider: 'slack' as const, createTask: vi.fn(providerImpl) };
    const deliver = createSlackQueueDelivery({
      db,
      integrationRepo: fakeIntegrationRepo({ channelId: 'C1', channelName: 'feedback', notifyOnNew: true }),
      provider,
      appUrl: 'https://app.test/',
    });
    const dispatcher = new DispatchPendingNotifications({
      notificationQueue: queue,
      userRepo: new FakeUserRepo(clock),
      mailer: new FakeMailer(),
      clock,
      logger: new FakeLogger(),
      channelDeliverers: { [SLACK_NOTIFICATION_KIND]: deliver },
    });
    const enqueue = () =>
      queue.enqueue(
        { kind: SLACK_NOTIFICATION_KIND, recipientUserId: '', orgId: 'org-1', projectId: 'p1', annotationId: 'a1', pinNumber: 4, severity: 'major', annotationType: 'note', status: 'open', body: 'Broken <b>', pageUrl: 'https://s.test/' },
        new Date('2024-06-01T00:00:00Z'),
      );
    return { dispatcher, queue, provider, inserted, enqueue, clock };
  }

  it('posts the annotation with the project link and records the permalink', async () => {
    const s = setup(async () => ({ externalId: 'C1:1.2', externalUrl: 'https://acme.slack.com/archives/C1/p12' }));
    const id = await s.enqueue();
    const res = await s.dispatcher.execute();
    expect(res.ok && res.value.dispatched).toEqual([{ id, outcome: 'sent' }]);
    const [ctx, task] = s.provider.createTask.mock.calls[0]!;
    expect(ctx.accessToken).toBe('xoxb-secret');
    expect(task.projectUrl).toBe('https://app.test/projects/p1');
    expect(task).toMatchObject({ severity: 'Major', annotationType: 'note', status: 'open', pinNumber: 4 });
    expect(s.inserted[0]).toMatchObject({ annotation_id: 'a1', provider: 'slack', external_url: 'https://acme.slack.com/archives/C1/p12', status: 'delivered' });
    expect(s.queue.rows.get(id)?.status).toBe('sent');
  });

  it('does not double-post when the annotation was already delivered to Slack', async () => {
    const s = setup(async () => ({ externalId: 'x', externalUrl: 'y' }), true);
    await s.enqueue();
    await s.dispatcher.execute();
    expect(s.provider.createTask).not.toHaveBeenCalled();
  });

  it('a transient failure (429 Retry-After) is rescheduled honouring Retry-After, not failed', async () => {
    const s = setup(async () => {
      throw new TaskDeliveryError('Slack is rate limiting requests.', { transient: true, status: 429, retryAfterSeconds: 600 });
    });
    const id = await s.enqueue();
    await s.dispatcher.execute();
    const row = s.queue.rows.get(id)!;
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(new Date(row.scheduledAt).getTime() - s.clock.now().getTime()).toBeGreaterThanOrEqual(600_000);
  });

  it('a permanent failure (not_in_channel) is marked failed with the invite hint', async () => {
    const s = setup(async () => {
      throw new TaskDeliveryError('The Pinpoint bot is not in #feedback. Invite it there.', { transient: false });
    });
    const id = await s.enqueue();
    await s.dispatcher.execute();
    const row = s.queue.rows.get(id)!;
    expect(row.status).toBe('failed');
    expect(row.lastError).toMatch(/Invite/);
  });
});

describe('createSlackWiring', () => {
  it('attach() hooks annotation.created in place without changing delivery to the original bus', async () => {
    const enqueue = vi.fn(async () => 'n1');
    const emitted: string[] = [];
    const bus = { emit: (e: { type: string }) => void emitted.push(e.type) };
    const wiring = createSlackWiring({
      db: (() => ({ where: () => ({ first: async () => ({ org_id: 'org-1' }) }) })) as any,
      integrationRepo: fakeIntegrationRepo({ channelId: 'C1', notifyOnNew: true }),
      notificationQueue: { enqueue },
      logger: new FakeLogger(),
      appUrl: 'https://app.test',
    });
    wiring.attach(bus as any);
    bus.emit({ type: 'annotation.created', room: 'r', payload: { id: 'a1', projectId: 'p1', orgId: 'org-1', severity: 'critical', body: 'x' } } as any);
    bus.emit({ type: 'comment.created', room: 'r', payload: {} } as any);
    await new Promise((r) => setTimeout(r, 0));
    expect(emitted).toEqual(['annotation.created', 'comment.created']);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(typeof wiring.channelDeliverers.slack_annotation).toBe('function');
  });
});
