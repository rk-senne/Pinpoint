/**
 * Standalone, idempotent demo-workspace seeder.
 *
 *   npm run demo:seed     create whatever is missing (safe to re-run)
 *   npm run demo:reset    delete ONLY demo-owned data, then seed again
 *
 * Talks to a running API (PINPOINT_API_URL, default http://127.0.0.1:3001) for
 * everything the public API can do, and to Postgres (DB_*) for the steps the
 * API deliberately cannot (marking users verified, switching a plan, backdating
 * timestamps, SLA breaches, minting a known invitation token).
 *
 * "Demo-owned" = organisations owned by an @acmestudio.dev user and the
 * @acmestudio.dev users themselves. Nothing else is touched.
 *
 * Env: PINPOINT_API_URL, PINPOINT_APP_URL (for printed links only), DB_HOST,
 * DB_PORT, DB_NAME, DB_USER, DB_PASSWORD.
 */
import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { assertLocalDb, connectDb, dbConfigFromEnv, log, tablesWithoutFk } from './lib/common.mts';

const API_URL = (process.env.PINPOINT_API_URL || 'http://127.0.0.1:3001').replace(/\/+$/, '');
const APP_URL = (process.env.PINPOINT_APP_URL || 'http://localhost:5173').replace(/\/+$/, '');
const SITE = 'https://acme-studio.example.com';
const DEMO_DOMAIN = '@acmestudio.dev';
export const DEMO_PASSWORD = 'Sunr1se-Studio-Demo!';
const NORTHWIND_PASSWORD = 'Review-2026!';

const MAYA = { email: `maya.chen${DEMO_DOMAIN}`, name: 'Maya Chen' };
const DANIEL = { email: `daniel.okafor${DEMO_DOMAIN}`, name: 'Daniel Okafor' };

// --------------------------------------------------------------------------
// Tiny HTTP client (bearer auth => CSRF-exempt)
// --------------------------------------------------------------------------

interface Res<T = any> {
  status: number;
  body: T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function http<T = any>(method: string, path: string, token: string | null, body?: unknown): Promise<Res<T>> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${API_URL}${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      let parsed: any = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      return { status: res.status, body: parsed };
    } catch (err) {
      // The API restarts for ~2s now and then on a shared dev stack.
      if (attempt < 6) {
        await sleep(1500);
        continue;
      }
      throw new Error(`API unreachable at ${API_URL}: ${(err as Error).message}`);
    }
  }
}

function expectOk(res: Res, what: string, ok: number[] = [200, 201]): Res {
  if (!ok.includes(res.status)) {
    throw new Error(`${what} failed: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
  }
  return res;
}

interface Actor {
  email: string;
  name: string;
  userId: string;
  orgId: string;
  token: string;
}

// --------------------------------------------------------------------------
// Demo data
// --------------------------------------------------------------------------

const ENV_CHROME = {
  browserFamily: 'Chrome', browserVersion: '126.0', osFamily: 'macOS', osVersion: '14.5', deviceType: 'desktop',
  userAgentRaw: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
};
const ENV_SAFARI_IOS = {
  browserFamily: 'Safari', browserVersion: '17.5', osFamily: 'iOS', osVersion: '17.5', deviceType: 'mobile',
  userAgentRaw: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};
const ENV_FIREFOX = {
  browserFamily: 'Firefox', browserVersion: '127.0', osFamily: 'Windows', osVersion: '11', deviceType: 'desktop',
  userAgentRaw: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
};

interface AnnSpec {
  body: string;
  type: 'note' | 'suggestion' | 'guideline';
  severity: 'critical' | 'major' | 'minor' | 'informational';
  status: 'open' | 'in_progress' | 'resolved';
  path: string;
  x: number;
  y: number;
  tag: string;
  selector: string;
  env: typeof ENV_CHROME;
  consoleLogs?: unknown[];
  jsErrors?: unknown[];
  replay?: boolean;
  /** Days ago the annotation "was created" (backdated in the DB). */
  ageDays: number;
}

const ACME_ANNOTATIONS: AnnSpec[] = [
  {
    body: 'Hero headline wraps onto three lines at 1280px and pushes the CTA below the fold.',
    type: 'note', severity: 'major', status: 'open', path: '/', x: 640, y: 180, tag: 'H1',
    selector: 'main .hero h1', env: ENV_CHROME, replay: true, ageDays: 6,
  },
  {
    body: 'Checkout button does nothing on iPhone Safari after the address step. Tapping it shows no feedback.',
    type: 'note', severity: 'critical', status: 'in_progress', path: '/pricing', x: 320, y: 940, tag: 'BUTTON',
    selector: '#checkout-submit', env: ENV_SAFARI_IOS, ageDays: 5,
    consoleLogs: [
      { level: 'warn', message: 'Stripe.js: payment element not mounted yet', timestamp: '2026-11-14T09:12:03.120Z' },
      { level: 'error', message: 'Failed to load resource: the server responded with a status of 422 ()', timestamp: '2026-11-14T09:12:04.402Z' },
    ],
    jsErrors: [
      { kind: 'error', message: "TypeError: Cannot read properties of undefined (reading 'clientSecret')", timestamp: '2026-11-14T09:12:04.410Z' },
    ],
  },
  {
    body: 'Consider swapping the grey "Contact sales" link for a filled button, it is easy to miss on the pricing table.',
    type: 'suggestion', severity: 'minor', status: 'open', path: '/pricing', x: 880, y: 620, tag: 'A',
    selector: '.pricing-table a.contact', env: ENV_FIREFOX, ageDays: 4,
  },
  {
    body: 'Footer link contrast is 3.1:1 against the navy background. Needs to hit 4.5:1 for WCAG AA.',
    type: 'guideline', severity: 'major', status: 'resolved', path: '/', x: 200, y: 1480, tag: 'A',
    selector: 'footer nav a', env: ENV_CHROME, ageDays: 4,
  },
  {
    body: 'Customer logos are blurry on retina displays. Can we ship the SVG versions instead of the 1x PNGs?',
    type: 'suggestion', severity: 'informational', status: 'in_progress', path: '/', x: 700, y: 760, tag: 'IMG',
    selector: '.logos img:nth-child(3)', env: ENV_CHROME, ageDays: 3,
  },
  {
    body: 'Newsletter signup shows a raw "400 Bad Request" toast when the email field is empty.',
    type: 'note', severity: 'minor', status: 'resolved', path: '/blog', x: 420, y: 300, tag: 'FORM',
    selector: 'form.newsletter', env: ENV_FIREFOX, ageDays: 2,
  },
  {
    body: 'Mobile navigation drawer overlaps the logo below 380px and the close button is unreachable.',
    type: 'note', severity: 'major', status: 'open', path: '/', x: 60, y: 40, tag: 'NAV',
    selector: 'header .nav-drawer', env: ENV_SAFARI_IOS, ageDays: 1,
  },
];

const NORTHWIND_ANNOTATIONS: AnnSpec[] = [
  {
    body: 'Invoice table scrolls horizontally on tablets; the "Pay now" column is cut off.',
    type: 'note', severity: 'major', status: 'open', path: '/portal/invoices', x: 900, y: 420, tag: 'TABLE',
    selector: 'table.invoices', env: ENV_CHROME, ageDays: 3,
  },
  {
    body: 'Could the project status badge use the same green as our brand guide (#1D4ED8 is too saturated)?',
    type: 'suggestion', severity: 'minor', status: 'in_progress', path: '/portal', x: 300, y: 210, tag: 'SPAN',
    selector: '.status-badge', env: ENV_CHROME, ageDays: 2,
  },
  {
    body: 'Login redirect lands on a blank page after the password reset email link is used.',
    type: 'note', severity: 'critical', status: 'resolved', path: '/portal/login', x: 500, y: 300, tag: 'FORM',
    selector: 'form.login', env: ENV_FIREFOX, ageDays: 1,
  },
];

function replayEvents(): unknown[] {
  const t0 = Date.now() - 6 * 86_400_000;
  const ev: unknown[] = [{ type: 'resize', timestamp: t0, data: { width: 1280, height: 800 } }];
  for (let i = 0; i < 24; i++) {
    ev.push({ type: 'mousemove', timestamp: t0 + 100 + i * 120, data: { x: 100 + i * 25, y: 150 + i * 12 } });
  }
  ev.push({ type: 'scroll', timestamp: t0 + 3200, data: { x: 0, y: 320 } });
  ev.push({ type: 'click', timestamp: t0 + 4100, data: { x: 700, y: 440 } });
  ev.push({ type: 'mousemove', timestamp: t0 + 5000, data: { x: 720, y: 450 } });
  return ev;
}

// --------------------------------------------------------------------------
// Reset: delete ONLY demo-owned data
// --------------------------------------------------------------------------

export async function resetDemoData(db: pg.Client): Promise<{ users: number; orgs: number; projects: number }> {
  await db.query('begin');
  try {
    const users = (await db.query<{ id: string }>(`select id from users where lower(email) like $1`, [`%${DEMO_DOMAIN}`])).rows.map((r) => r.id);
    if (users.length === 0) {
      await db.query('rollback');
      return { users: 0, orgs: 0, projects: 0 };
    }
    // Orgs whose OWNER is a demo user (Maya's org, personal orgs of demo users).
    const orgs = (
      await db.query<{ id: string }>(
        `select distinct org_id as id from memberships where role = 'owner' and user_id = any($1::uuid[])`,
        [users],
      )
    ).rows.map((r) => r.id);
    const projects = (
      await db.query<{ id: string }>(
        `select id from projects where org_id = any($1::uuid[]) or owner_id = any($2::uuid[])`,
        [orgs, users],
      )
    ).rows.map((r) => r.id);

    // Tables without an FK to the parent do not cascade — clear them by hand.
    for (const t of await tablesWithoutFk(db, 'project_id')) {
      await db.query(`delete from "${t}" where project_id = any($1::uuid[])`, [projects]);
    }
    for (const t of await tablesWithoutFk(db, 'org_id')) {
      await db.query(`delete from "${t}" where org_id = any($1::uuid[])`, [orgs]);
    }
    await db.query(`delete from teams where owner_id = any($1::uuid[])`, [users]);
    await db.query(`delete from organizations where id = any($1::uuid[])`, [orgs]);
    await db.query(`delete from users where id = any($1::uuid[])`, [users]);
    await db.query('commit');
    return { users: users.length, orgs: orgs.length, projects: projects.length };
  } catch (err) {
    await db.query('rollback');
    throw err;
  }
}

// --------------------------------------------------------------------------
// Seed steps
// --------------------------------------------------------------------------

async function ensureUser(db: pg.Client, who: { email: string; name: string }): Promise<Actor> {
  const exists = (await db.query(`select 1 from users where email = $1`, [who.email])).rowCount;
  if (!exists) {
    // 201 on success; the user is created unverified.
    expectOk(await http('POST', '/api/v1/auth/register', null, { email: who.email, password: DEMO_PASSWORD, name: who.name }), `register ${who.email}`);
  }
  await db.query(`update users set verified = true where email = $1`, [who.email]);
  const login = await http('POST', '/api/v1/auth/login', null, { email: who.email, password: DEMO_PASSWORD });
  if (login.status !== 200) {
    throw new Error(`login ${who.email} failed (HTTP ${login.status}). If this account exists with another password run \`npm run demo:reset\`.`);
  }
  const userId: string = login.body.user.id;
  const { rows } = await db.query<{ org_id: string }>(`select org_id from memberships where user_id = $1 order by created_at limit 1`, [userId]);
  return { ...who, userId, orgId: rows[0]!.org_id, token: login.body.token };
}

async function ensureProPlan(db: pg.Client, orgId: string): Promise<void> {
  // Billing is enforced by plan NAME (PLAN_LIMITS); plan_limits is informational.
  await db.query(
    `update organizations set plan = 'pro', plan_status = 'active',
       plan_limits = '{"seats": 10, "projects": 1000, "integrations": 10, "annotations_per_month": 100000}'::jsonb
     where id = $1`,
    [orgId],
  );
}

async function ensureDanielInMayasOrg(db: pg.Client, maya: Actor, daniel: Actor): Promise<string> {
  const member = (await db.query(`select 1 from memberships where user_id = $1 and org_id = $2`, [daniel.userId, maya.orgId])).rowCount;
  if (!member) {
    // Only the hash of an invitation token is stored, so mint a known one.
    await db.query(`delete from invitations where org_id = $1 and lower(email) = $2`, [maya.orgId, daniel.email]);
    const inv = expectOk(await http('POST', '/api/v1/org/invitations', maya.token, { email: daniel.email, role: 'member' }), 'invite Daniel');
    const raw = randomBytes(24).toString('hex');
    await db.query(`update invitations set token = $1 where id = $2`, [createHash('sha256').update(raw).digest('hex'), inv.body.invitationId]);
    expectOk(await http('POST', '/api/v1/org/invitations/accept', daniel.token, { token: raw }), 'Daniel accepts invitation');
  }
  const sw = expectOk(await http('POST', '/api/v1/org/switch', daniel.token, { orgId: maya.orgId }), 'Daniel switches org');
  return sw.body.token as string;
}

async function ensureTeam(db: pg.Client, maya: Actor, daniel: Actor): Promise<string> {
  const list = expectOk(await http('GET', '/api/v1/teams?pageSize=100', maya.token), 'list teams');
  let team = (list.body.data as Array<{ id: string; name: string }>).find((t) => t.name === 'Design & QA');
  if (!team) {
    team = expectOk(await http('POST', '/api/v1/teams', maya.token, { name: 'Design & QA' }), 'create team').body.team;
  }
  const isMember = (await db.query(`select 1 from team_members where team_id = $1 and user_id = $2`, [team!.id, daniel.userId])).rowCount;
  if (!isMember) {
    expectOk(await http('POST', `/api/v1/teams/${team!.id}/invite`, maya.token, { email: daniel.email }), 'invite Daniel to team');
  }
  return team!.id;
}

async function findProject(maya: Actor, name: string): Promise<string | null> {
  const res = expectOk(await http('GET', `/api/v1/projects?search=${encodeURIComponent(name)}&pageSize=100`, maya.token), 'list projects');
  return (res.body.data as Array<{ id: string; name: string }>).find((p) => p.name === name)?.id ?? null;
}

async function createAnnotation(db: pg.Client, maya: Actor, projectId: string, spec: AnnSpec): Promise<string> {
  const data: Record<string, unknown> = {
    pageUrl: new URL(spec.path, SITE).toString(),
    body: spec.body,
    type: spec.type,
    severity: spec.severity,
    target: {
      cssSelector: spec.selector,
      xpath: `/html/body/${spec.tag.toLowerCase()}`,
      pageX: spec.x, pageY: spec.y, tagName: spec.tag, textSnippet: '',
    },
    environment: spec.env,
  };
  if (spec.consoleLogs) data.consoleLogs = spec.consoleLogs;
  if (spec.jsErrors) data.jsErrors = spec.jsErrors;
  if (spec.replay) data.sessionReplay = replayEvents();
  const res = expectOk(await http('POST', `/api/v1/projects/${projectId}/annotations`, maya.token, data), 'create annotation');
  const id: string = res.body.annotation.id;
  if (spec.status !== 'open') {
    expectOk(await http('PUT', `/api/v1/annotations/${id}/status`, maya.token, { status: spec.status }), 'set status');
  }
  // Spread creation times across the last week so analytics/trends are not a single spike.
  await db.query(
    `update annotations set created_at = now() - make_interval(days => $2, hours => $3) where id = $1`,
    [id, spec.ageDays, Math.floor(Math.random() * 6)],
  );
  return id;
}

async function annotationCount(db: pg.Client, projectId: string): Promise<number> {
  return Number((await db.query(`select count(*) from annotations where project_id = $1`, [projectId])).rows[0].count);
}

/** Create the project if missing; rebuild it if a previous run died half way. */
async function ensureProject(
  db: pg.Client, maya: Actor, name: string, urls: string[], expected: number, teamId?: string,
): Promise<{ id: string; fresh: boolean }> {
  const existing = await findProject(maya, name);
  if (existing) {
    if ((await annotationCount(db, existing)) >= expected) return { id: existing, fresh: false };
    expectOk(await http('DELETE', `/api/v1/projects/${existing}`, maya.token, { confirmationToken: name }), 'delete partial project', [200, 204]);
  }
  const created = expectOk(await http('POST', '/api/v1/projects', maya.token, { name, urls, ...(teamId ? { teamId } : {}) }), `create project ${name}`);
  return { id: created.body.project.id as string, fresh: true };
}

async function ensureShareLink(db: pg.Client, maya: Actor, projectId: string, opts: { password?: string }): Promise<string> {
  const row = (await db.query<{ id: string }>(`select id from shared_links where project_id = $1 limit 1`, [projectId])).rows[0];
  if (row) return row.id;
  const res = expectOk(await http('POST', `/api/v1/projects/${projectId}/share`, maya.token, { allowFeedback: true, ...(opts.password ? { password: opts.password } : {}) }), 'create share link');
  return res.body.sharedLink.id as string;
}

async function seedAcme(db: pg.Client, maya: Actor, daniel: Actor, danielToken: string, teamId: string) {
  const { id: projectId, fresh } = await ensureProject(
    db, maya, 'Acme Marketing Site', [`${SITE}/`, `${SITE}/pricing`, `${SITE}/blog`], ACME_ANNOTATIONS.length + 1, teamId,
  );
  const linkId = await ensureShareLink(db, maya, projectId, {});
  if (fresh) {
    const ids: string[] = [];
    for (const spec of ACME_ANNOTATIONS) ids.push(await createAnnotation(db, maya, projectId, spec));

    const comment = async (token: string, annId: string, body: string, mentions: string[] = []) =>
      expectOk(await http('POST', `/api/v1/annotations/${annId}/comments`, token, { body, mentions }), 'add comment');
    await comment(maya.token, ids[1]!, 'Reproduced on an iPhone 14. The Stripe element never mounts after the address step.');
    await comment(danielToken, ids[1]!, '@Maya Chen I can see the 422 in the logs, looks like the payment intent is created without a customer. Taking this one.', [maya.userId]);
    await comment(maya.token, ids[1]!, 'Thanks! Customers are hitting this today, so I flagged it critical. Ping me when a fix is on staging.');
    await comment(maya.token, ids[0]!, 'Design suggests clamping the headline to two lines with a smaller max font size.');
    await comment(danielToken, ids[0]!, '@Maya Chen agreed. I will try `clamp(2rem, 4vw, 3.25rem)` and share a preview link.', [maya.userId]);
    await comment(danielToken, ids[3]!, 'Fixed in #482: footer links now use #cbd5e1 on navy (7.9:1).');

    // Assignees + due dates: one soon, one overdue (drives the SLA / overdue views).
    const day = 86_400_000;
    const put = async (id: string, patch: Record<string, unknown>) =>
      expectOk(await http('PUT', `/api/v1/annotations/${id}`, danielToken, patch), 'update annotation');
    await put(ids[1]!, { assigneeId: daniel.userId, dueDate: new Date(Date.now() + 3 * day).toISOString() });
    await put(ids[0]!, { assigneeId: daniel.userId, dueDate: new Date(Date.now() - 1 * day).toISOString() });
    await put(ids[6]!, { assigneeId: daniel.userId, dueDate: new Date(Date.now() + 7 * day).toISOString() });

    // Guest submission through the public feedback link.
    expectOk(
      await http('POST', `/api/v1/shared/${linkId}/feedback`, null, {
        name: 'Priya Nair',
        email: 'priya.nair@northwind.example',
        description: 'The testimonials carousel jumps back to the first slide whenever I scroll past it.',
        pageUrl: `${SITE}/`,
        severity: 'minor',
      }),
      'guest feedback',
    );
  }
  return { projectId, linkId, fresh };
}

async function seedNorthwind(db: pg.Client, maya: Actor) {
  const { id: projectId, fresh } = await ensureProject(db, maya, 'Northwind Client Portal', [`${SITE}/portal`], NORTHWIND_ANNOTATIONS.length);
  const linkId = await ensureShareLink(db, maya, projectId, { password: NORTHWIND_PASSWORD });
  if (fresh) {
    for (const spec of NORTHWIND_ANNOTATIONS) await createAnnotation(db, maya, projectId, spec);
  }
  return { projectId, linkId };
}

async function ensureGuideline(maya: Actor): Promise<void> {
  const list = expectOk(await http('GET', '/api/v1/guidelines?pageSize=100', maya.token), 'list guidelines');
  if ((list.body.data as Array<{ name: string }>).some((g) => g.name === 'Brand voice')) return;
  expectOk(await http('POST', '/api/v1/guidelines', maya.token, {
    name: 'Brand voice',
    description: 'Headlines are sentence case, no exclamation marks, max 8 words.',
  }), 'create guideline');
}

async function ensureWidgetKey(maya: Actor, projectId: string): Promise<{ created: boolean; rawKey?: string; prefix: string }> {
  const list = expectOk(await http('GET', '/api/v1/api-keys', maya.token), 'list api keys');
  const existing = (list.body.data as any[]).find(
    (k) => k.name === 'Acme marketing widget' && (k.keyType ?? k.key_type) === 'widget' && !(k.revokedAt ?? k.revoked_at),
  );
  if (existing) return { created: false, prefix: existing.keyPrefix ?? existing.key_prefix };
  const res = expectOk(await http('POST', '/api/v1/api-keys', maya.token, {
    name: 'Acme marketing widget',
    keyType: 'widget',
    projectId,
    allowedOrigins: ['http://localhost:5173', SITE],
    dailyQuota: 500,
  }), 'create widget key');
  return { created: true, rawKey: res.body.rawKey as string, prefix: res.body.keyPrefix ?? res.body.key_prefix };
}

async function ensurePortals(db: pg.Client, maya: Actor, acmeId: string, northwindId: string) {
  const list = expectOk(await http('GET', '/api/v1/portals?pageSize=100', maya.token), 'list portals');
  const have = new Set((list.body.data as Array<{ slug: string }>).map((p) => p.slug));
  const defs = [
    {
      slug: 'demo-acme-feedback', projectId: acmeId, title: 'Acme Marketing Site: feedback hub',
      welcomeMessage: 'Welcome! Review the open issues on the redesign and add anything we missed. Your email is only used to send you a sign-in link.',
      brandColor: '#0f766e', allowNewFeedback: true, requireEmail: true,
      company: 'Acme Studio', support: 'hello@acmestudio.dev',
    },
    {
      slug: 'demo-northwind-portal', projectId: northwindId, title: 'Northwind: client review portal',
      welcomeMessage: 'Hi Northwind team, this is where you can follow progress and sign off on fixes. New requests go through your account manager.',
      brandColor: '#1d4ed8', allowNewFeedback: false, requireEmail: true,
      company: 'Northwind Traders', support: 'projects@acmestudio.dev',
    },
  ];
  for (const d of defs) {
    if (have.has(d.slug)) continue;
    expectOk(await http('POST', '/api/v1/portals', maya.token, {
      projectId: d.projectId, title: d.title, slug: d.slug, welcomeMessage: d.welcomeMessage,
      brandColor: d.brandColor, allowNewFeedback: d.allowNewFeedback, requireEmail: d.requireEmail,
    }), `create portal ${d.slug}`);
    await db.query(`update client_portals set company_name = $2, support_email = $3 where slug = $1`, [d.slug, d.company, d.support]);
  }
  return defs.map((d) => d.slug);
}

async function ensureWorkflows(db: pg.Client, maya: Actor, daniel: Actor, acmeId: string) {
  const rules = expectOk(await http('GET', '/api/v1/workflows/rules?pageSize=100', maya.token), 'list rules');
  const haveRules = new Set((rules.body.data as Array<{ name: string }>).map((r) => r.name));
  const ruleDefs = [
    { name: 'Assign critical bugs to Daniel', triggerEvent: 'annotation.created', conditions: { severity: 'critical' }, actionType: 'assign', actionParams: { assigneeId: daniel.userId }, priority: 1, projectId: acmeId },
    { name: 'Due date 3 days out for major issues', triggerEvent: 'annotation.created', conditions: { severity: 'major' }, actionType: 'set_due_date', actionParams: { daysFromNow: 3 }, priority: 2 },
    { name: 'Notify the team when feedback is resolved', triggerEvent: 'annotation.status_changed', conditions: { status: 'resolved' }, actionType: 'notify', actionParams: { channel: 'email', recipients: 'team' }, priority: 3 },
    { name: 'Start work on first reply', triggerEvent: 'comment.created', conditions: { annotationStatus: 'open' }, actionType: 'set_status', actionParams: { status: 'in_progress' }, priority: 4 },
  ];
  for (const r of ruleDefs) {
    if (!haveRules.has(r.name)) expectOk(await http('POST', '/api/v1/workflows/rules', maya.token, r), `create rule ${r.name}`);
  }

  const slas = expectOk(await http('GET', '/api/v1/workflows/sla?pageSize=100', maya.token), 'list SLAs');
  const haveSla = new Set((slas.body.data as Array<{ name: string }>).map((p) => p.name));
  const slaDefs = [
    { name: 'Critical: same-day fix', severity: 'critical', responseTimeHours: 1, resolutionTimeHours: 8 },
    { name: 'Major: two-day turnaround', severity: 'major', responseTimeHours: 4, resolutionTimeHours: 48 },
    { name: 'Minor: weekly sweep', severity: 'minor', responseTimeHours: 24, resolutionTimeHours: 120 },
  ];
  for (const s of slaDefs) {
    if (!haveSla.has(s.name)) expectOk(await http('POST', '/api/v1/workflows/sla', maya.token, s), `create SLA ${s.name}`);
  }

  // Sample SLA breaches (no API to create them: a scheduled job does it in production).
  const policy = async (name: string) =>
    (await db.query<{ id: string }>(`select id from sla_policies where org_id = $1 and name = $2`, [maya.orgId, name])).rows[0]?.id;
  const ann = async (like: string) =>
    (await db.query<{ id: string }>(`select id from annotations where project_id = $1 and body like $2 limit 1`, [acmeId, `${like}%`])).rows[0]?.id;
  const breaches: Array<[string, string, string]> = [
    ['Checkout button does nothing', 'Critical: same-day fix', 'resolution'],
    ['Hero headline wraps', 'Major: two-day turnaround', 'resolution'],
  ];
  for (const [prefix, policyName, type] of breaches) {
    const [annotationId, policyId] = [await ann(prefix), await policy(policyName)];
    if (!annotationId || !policyId) continue;
    const dup = (await db.query(`select 1 from sla_breaches where annotation_id = $1 and sla_policy_id = $2 and breach_type = $3`, [annotationId, policyId, type])).rowCount;
    if (!dup) {
      await db.query(
        `insert into sla_breaches (annotation_id, sla_policy_id, breach_type, breached_at) values ($1, $2, $3, now() - interval '5 hours')`,
        [annotationId, policyId, type],
      );
    }
  }
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

async function main(): Promise<void> {
  const reset = process.argv.includes('--reset');
  const cfg = dbConfigFromEnv();
  assertLocalDb(cfg, { requireKnownName: true });
  const db = connectDb(cfg);
  await db.connect();
  try {
    const health = await http('GET', '/health', null);
    if (health.status >= 500 || health.status === 0) throw new Error(`API at ${API_URL} is not healthy (HTTP ${health.status}).`);

    if (reset) {
      const r = await resetDemoData(db);
      log(`Reset: removed ${r.users} demo users, ${r.orgs} orgs, ${r.projects} projects.`);
    }

    log(`Seeding demo workspace via ${API_URL} (db ${cfg.host}:${cfg.port}/${cfg.database})…`);
    const maya = await ensureUser(db, MAYA);
    const daniel = await ensureUser(db, DANIEL);
    await ensureProPlan(db, maya.orgId);
    const danielToken = await ensureDanielInMayasOrg(db, maya, daniel);
    const teamId = await ensureTeam(db, maya, daniel);
    log('  users, org (pro) and team ready');

    const acme = await seedAcme(db, maya, daniel, danielToken, teamId);
    log(`  Acme Marketing Site ${acme.fresh ? 'created' : 'already present'}`);
    const nw = await seedNorthwind(db, maya);
    log('  Northwind Client Portal ready (password-protected share link)');
    await ensureGuideline(maya);
    const key = await ensureWidgetKey(maya, acme.projectId);
    const slugs = await ensurePortals(db, maya, acme.projectId, nw.projectId);
    await ensureWorkflows(db, maya, daniel, acme.projectId);
    log('  guideline, widget key, client portals, automation rules + SLAs ready');

    log('');
    log('Demo workspace ready');
    log('────────────────────────────────────────────────────────');
    log(`Login:           ${MAYA.email}  /  ${DEMO_PASSWORD}   (owner, Pro)`);
    log(`Teammate:        ${DANIEL.email}  /  ${DEMO_PASSWORD}`);
    log(`Dashboard:       ${APP_URL}/auth`);
    log(`Projects:        ${APP_URL}/projects/${acme.projectId}   (Acme Marketing Site)`);
    log(`Portals:         ${APP_URL}/portals`);
    for (const s of slugs) log(`  portal "${s}": ${APP_URL}/api/v1/portals/${s}/info`);
    log(`Workflows:       ${APP_URL}/workflows`);
    log(`Open share link: ${APP_URL}/shared/${acme.linkId}`);
    log(`Protected link:  ${APP_URL}/shared/${nw.linkId}   password: ${NORTHWIND_PASSWORD}`);
    log(key.created ? `Widget key:      ${key.rawKey}   (shown once)` : `Widget key:      ${key.prefix}…  (exists; \`npm run demo:reset\` mints a new visible key)`);
    log(`Widget snippet:  <script src="${APP_URL}/widget/pinpoint-widget.js"></script> + Pinpoint.init({ projectKey: '<widget key>' })`);
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  process.stderr.write(`demo-seed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
