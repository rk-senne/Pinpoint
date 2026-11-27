/**
 * Demo-world seeding for the dashboard UI audit + interaction specs.
 *
 * Creates real accounts (via the public API), promotes them to the `pro`
 * plan and the "verified" state straight in Postgres (the SMTP sink does not
 * deliver verification mail to the test), and builds a product-demo dataset:
 * a project with realistic annotations, comments, a guest submission, a team.
 *
 * Visible names deliberately avoid "test"/"e2e" so screenshots read like a
 * real workspace.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { type APIRequestContext, request as requestFactory } from '@playwright/test';

import { API_URL } from './helpers.js';

const PSQL = process.env.PINPOINT_PSQL ?? '/Library/PostgreSQL/18/bin/psql';
const PG_PORT = process.env.PINPOINT_PG_PORT ?? '5544';

export const DEMO_PASSWORD = 'Sunr1se-Studio-Demo!';

/** Run SQL against the local stack's Postgres and return trimmed stdout. */
export function sql(statement: string): string {
  return execFileSync(
    PSQL,
    ['-h', '127.0.0.1', '-p', PG_PORT, '-U', 'postgres', '-d', 'pinpoint', '-At', '-c', statement],
    { encoding: 'utf8', env: { ...process.env, PGPASSWORD: 'x' } },
  ).trim();
}

export function sha256Hex(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export interface DemoUser {
  email: string;
  name: string;
  password: string;
  userId: string;
  token: string;
  orgId: string;
  ctx: APIRequestContext;
  dispose(): Promise<void>;
}

async function bearerCtx(token: string): Promise<APIRequestContext> {
  return requestFactory.newContext({
    baseURL: API_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
}

/** Register (idempotent), verify in the DB, log in and return a bearer-bound client. */
export async function ensureUser(opts: {
  email: string;
  name: string;
  password?: string;
  pro?: boolean;
}): Promise<DemoUser> {
  const password = opts.password ?? DEMO_PASSWORD;
  const anon = await requestFactory.newContext({ baseURL: API_URL });
  try {
    await anon.post('/api/v1/auth/register', {
      data: { email: opts.email, password, name: opts.name, acceptTerms: true },
    });
    sql(`update users set verified = true where email = '${opts.email.toLowerCase()}'`);
    const res = await anon.post('/api/v1/auth/login', { data: { email: opts.email, password } });
    if (!res.ok()) throw new Error(`demo login failed ${res.status()} ${await res.text()}`);
    const body = (await res.json()) as { user: { id: string }; token: string };
    const orgId = sql(
      `select org_id from memberships where user_id = '${body.user.id}' order by created_at limit 1`,
    );
    if (opts.pro && orgId) {
      sql(
        `update organizations set plan = 'pro', plan_limits = (select plan_limits from organizations where plan = 'pro' and plan_limits->>'projects' is not null order by created_at limit 1) where id = '${orgId}'`,
      );
    }
    const ctx = await bearerCtx(body.token);
    return {
      email: opts.email,
      name: opts.name,
      password,
      userId: body.user.id,
      token: body.token,
      orgId,
      ctx,
      dispose: () => ctx.dispose(),
    };
  } finally {
    await anon.dispose();
  }
}

/**
 * Invite `inviteeEmail` into the inviter's org and mint a KNOWN raw token by
 * overwriting the stored hash (the real token is only ever emailed).
 * Returns the raw token for `/invitations/accept?token=…`.
 */
export async function inviteWithKnownToken(
  inviter: DemoUser,
  inviteeEmail: string,
  role: 'admin' | 'member' | 'viewer' = 'member',
): Promise<string> {
  sql(`delete from invitations where org_id = '${inviter.orgId}' and lower(email) = '${inviteeEmail.toLowerCase()}'`);
  const res = await inviter.ctx.post('/api/v1/org/invitations', {
    data: { email: inviteeEmail, role },
  });
  if (res.status() !== 201) throw new Error(`invite failed ${res.status()} ${await res.text()}`);
  const { invitationId } = (await res.json()) as { invitationId: string };
  const raw = randomBytes(24).toString('hex');
  sql(`update invitations set token = '${sha256Hex(raw)}' where id = '${invitationId}'`);
  return raw;
}

/** Accept an invitation as `invitee` and switch their active org; returns a fresh bearer ctx. */
export async function acceptAndSwitch(invitee: DemoUser, rawToken: string, orgId: string): Promise<APIRequestContext> {
  const acc = await invitee.ctx.post('/api/v1/org/invitations/accept', { data: { token: rawToken } });
  if (!acc.ok()) throw new Error(`accept failed ${acc.status()} ${await acc.text()}`);
  const sw = await invitee.ctx.post('/api/v1/org/switch', { data: { orgId } });
  if (!sw.ok()) throw new Error(`switch failed ${sw.status()} ${await sw.text()}`);
  const { token } = (await sw.json()) as { token: string };
  return bearerCtx(token);
}

const ENV_CHROME = {
  browserFamily: 'Chrome',
  browserVersion: '126.0',
  osFamily: 'macOS',
  osVersion: '14.5',
  deviceType: 'desktop',
  userAgentRaw:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
};
const ENV_SAFARI_IOS = {
  browserFamily: 'Safari',
  browserVersion: '17.5',
  osFamily: 'iOS',
  osVersion: '17.5',
  deviceType: 'mobile',
  userAgentRaw:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};
const ENV_FIREFOX = {
  browserFamily: 'Firefox',
  browserVersion: '127.0',
  osFamily: 'Windows',
  osVersion: '11',
  deviceType: 'desktop',
  userAgentRaw: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
};

export interface DemoAnnotationSpec {
  body: string;
  type: 'note' | 'suggestion' | 'guideline';
  severity: 'critical' | 'major' | 'minor' | 'informational';
  status?: 'open' | 'in_progress' | 'resolved';
  path: string;
  x: number;
  y: number;
  tag: string;
  selector: string;
  env?: typeof ENV_CHROME;
  consoleLogs?: unknown[];
  jsErrors?: unknown[];
  sessionReplay?: unknown[];
}

export const ACME_ANNOTATIONS: DemoAnnotationSpec[] = [
  {
    body: 'Hero headline wraps onto three lines at 1280px and pushes the CTA below the fold.',
    type: 'note', severity: 'major', status: 'open', path: '/', x: 640, y: 180, tag: 'H1',
    selector: 'main .hero h1', env: ENV_CHROME,
  },
  {
    body: 'Checkout button does nothing on iPhone Safari after the address step. Tapping it shows no feedback.',
    type: 'note', severity: 'critical', status: 'in_progress', path: '/pricing', x: 320, y: 940, tag: 'BUTTON',
    selector: '#checkout-submit', env: ENV_SAFARI_IOS,
    consoleLogs: [
      { level: 'warn', message: 'Stripe.js: payment element not mounted yet', timestamp: '2026-11-14T09:12:03.120Z' },
      { level: 'error', message: "Failed to load resource: the server responded with a status of 422 ()", timestamp: '2026-11-14T09:12:04.402Z' },
    ],
    jsErrors: [
      { kind: 'error', message: "TypeError: Cannot read properties of undefined (reading 'clientSecret')", timestamp: '2026-11-14T09:12:04.410Z' },
    ],
  },
  {
    body: 'Consider swapping the grey "Contact sales" link for a filled button, it is easy to miss on the pricing table.',
    type: 'suggestion', severity: 'minor', status: 'open', path: '/pricing', x: 880, y: 620, tag: 'A',
    selector: '.pricing-table a.contact', env: ENV_FIREFOX,
  },
  {
    body: 'Footer link contrast is 3.1:1 against the navy background. Needs to hit 4.5:1 for WCAG AA.',
    type: 'guideline', severity: 'major', status: 'resolved', path: '/', x: 200, y: 1480, tag: 'A',
    selector: 'footer nav a', env: ENV_CHROME,
  },
  {
    body: 'Customer logos are blurry on retina displays. Can we ship the SVG versions instead of the 1x PNGs?',
    type: 'suggestion', severity: 'informational', status: 'in_progress', path: '/', x: 700, y: 760, tag: 'IMG',
    selector: '.logos img:nth-child(3)', env: ENV_CHROME,
  },
  {
    body: 'Newsletter signup shows a raw "400 Bad Request" toast when the email field is empty.',
    type: 'note', severity: 'minor', status: 'resolved', path: '/blog', x: 420, y: 300, tag: 'FORM',
    selector: 'form.newsletter', env: ENV_FIREFOX,
  },
];

/** A short but real-looking replay: pointer moves, a click and a scroll. */
export function demoReplayEvents(): unknown[] {
  const t0 = 1_731_600_000_000;
  const ev: unknown[] = [{ type: 'resize', timestamp: t0, data: { width: 1280, height: 800 } }];
  for (let i = 0; i < 24; i++) {
    ev.push({ type: 'mousemove', timestamp: t0 + 100 + i * 120, data: { x: 100 + i * 25, y: 150 + i * 12 } });
  }
  ev.push({ type: 'scroll', timestamp: t0 + 3200, data: { x: 0, y: 320 } });
  ev.push({ type: 'click', timestamp: t0 + 4100, data: { x: 700, y: 440 } });
  ev.push({ type: 'mousemove', timestamp: t0 + 5000, data: { x: 720, y: 450 } });
  return ev;
}

export async function createDemoAnnotation(
  ctx: APIRequestContext,
  projectId: string,
  baseUrl: string,
  spec: DemoAnnotationSpec,
): Promise<{ id: string; pinNumber: number }> {
  const data: Record<string, unknown> = {
    pageUrl: new URL(spec.path, baseUrl).toString(),
    body: spec.body,
    type: spec.type,
    severity: spec.severity,
    target: {
      cssSelector: spec.selector,
      xpath: `/html/body/${spec.tag.toLowerCase()}`,
      pageX: spec.x,
      pageY: spec.y,
      tagName: spec.tag,
      textSnippet: '',
    },
    environment: spec.env ?? ENV_CHROME,
  };
  if (spec.consoleLogs) data.consoleLogs = spec.consoleLogs;
  if (spec.jsErrors) data.jsErrors = spec.jsErrors;
  if (spec.sessionReplay) data.sessionReplay = spec.sessionReplay;
  const res = await ctx.post(`/api/v1/projects/${projectId}/annotations`, { data });
  if (res.status() !== 201) throw new Error(`annotation failed ${res.status()} ${await res.text()}`);
  const { annotation } = (await res.json()) as { annotation: { id: string; pinNumber: number } };
  if (spec.status && spec.status !== 'open') {
    const s = await ctx.put(`/api/v1/annotations/${annotation.id}/status`, { data: { status: spec.status } });
    if (!s.ok()) throw new Error(`status failed ${s.status()} ${await s.text()}`);
  }
  return annotation;
}

export async function addComment(
  ctx: APIRequestContext,
  annotationId: string,
  body: string,
  mentions: string[] = [],
): Promise<void> {
  const res = await ctx.post(`/api/v1/annotations/${annotationId}/comments`, { data: { body, mentions } });
  if (res.status() !== 201) throw new Error(`comment failed ${res.status()} ${await res.text()}`);
}
