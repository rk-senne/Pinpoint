/**
 * Load-test dataset seeder (LOCAL database only).
 *
 *   node loadtest/seed.mts            # create whatever is missing (idempotent)
 *   node loadtest/seed.mts --clean    # delete everything this script created
 *   node loadtest/seed.mts --scale=0.1  # 10 % of the annotation/comment/audit rows
 *
 * Inserts straight into Postgres as the schema owner (RLS is bypassed on the
 * system path) so 50k annotations / 100k comments load in seconds. Everything
 * is namespaced by the `loadtest-` prefix (org names/slugs, user e-mails) so it
 * can be found and removed again. Needs Node >= 22.18 (native type stripping).
 *
 * Output: loadtest/.tokens.json (gitignored) with offline-minted session JWTs
 * (same claims and secret as JwtTokenIssuer) plus widget keys for the k6 runs.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { assertLocalDb, connectDb, dbConfigFromEnv, log, tablesWithoutFk } from '../scripts/lib/common.mts';

const require = createRequire(import.meta.url);
const bcrypt = require('bcrypt') as { hashSync(p: string, rounds: number): string };
const jwt = require('jsonwebtoken') as typeof import('jsonwebtoken');

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKENS_FILE = join(HERE, '.tokens.json');
const PREFIX = 'loadtest-';
const EMAIL_DOMAIN = 'loadtest.example.test';
export const LOADTEST_PASSWORD = 'LoadTest-Passw0rd!';

const ORGS = 20;
const USERS_PER_ORG = 10;
const PROJECTS = 100;
// `--scale=0.1` shrinks the row counts (CI smoke uses 0.1); orgs/users/projects/keys stay fixed.
const scaleArg = process.argv.find((a) => a.startsWith('--scale='));
const SCALE = scaleArg ? Number(scaleArg.slice('--scale='.length)) : 1;
if (!(SCALE > 0 && SCALE <= 1)) throw new Error('--scale must be in (0, 1]');
const ANNOTATIONS = Math.round(50_000 * SCALE);
const COMMENTS = Math.round(100_000 * SCALE);
const AUDIT_ROWS = Math.round(20_000 * SCALE);
const WIDGET_KEYS = 200;
const TOKEN_USERS_PER_ORG = 2; // users 0 and 1 own the projects and get tokens

const clean = process.argv.includes('--clean');
mkdirSync(join(HERE, 'results'), { recursive: true });

async function main(): Promise<void> {
  const cfg = dbConfigFromEnv();
  assertLocalDb(cfg);
  const db = connectDb(cfg);
  await db.connect();
  try {
    if (clean) {
      await doClean(db);
      return;
    }
    const { rows } = await db.query(`select count(*)::int as n from organizations where slug like $1`, [`${PREFIX}%`]);
    if (rows[0].n >= ORGS) {
      log(`Dataset already present (${rows[0].n} loadtest orgs) — only refreshing tokens.`);
    } else {
      if (rows[0].n > 0) await doClean(db); // partial leftovers: start over
      await seed(db);
    }
    await writeTokens(db);
  } finally {
    await db.end();
  }
}

type Db = ReturnType<typeof connectDb>;

async function seed(db: Db): Promise<void> {
  const hash = bcrypt.hashSync(LOADTEST_PASSWORD, 10);
  const t0 = Date.now();
  await db.query('begin');
  try {
    await db.query('select setseed(0.4242)');
    await db.query(
      `insert into organizations (name, slug, plan, plan_status, plan_limits, created_at)
       select $1 || lpad(g::text, 2, '0'), $1 || lpad(g::text, 2, '0'), 'pro', 'active',
              '{"seats": 10, "projects": 1000, "integrations": 10, "annotations_per_month": 100000}'::jsonb,
              now() - interval '100 days'
         from generate_series(1, $2) g`,
      [`${PREFIX}org-`, ORGS],
    );
    await db.query(
      `insert into users (email, password_hash, name, verified, token_version, accepted_terms_at, terms_version, created_at)
       select $1 || lpad(o::text, 2, '0') || '-u' || lpad(u::text, 2, '0') || '@' || $2,
              $3, 'Loadtest User ' || o || '-' || u, true, 0, now(), 'loadtest', now() - interval '99 days'
         from generate_series(1, $4) o, generate_series(0, $5) u`,
      [`${PREFIX}`, EMAIL_DOMAIN, hash, ORGS, USERS_PER_ORG - 1],
    );
    await db.query(
      `insert into memberships (org_id, user_id, role, accepted_at)
       select o.id, u.id, case when split_part(u.email, '-u', 2) like '00@%' then 'owner'
                               when split_part(u.email, '-u', 2) like '01@%' then 'admin' else 'member' end, now()
         from organizations o
         join users u on substring(u.email from '^loadtest-(\\d+)-u') = substring(o.slug from '\\d+$')
                     and u.email like '%@' || $2
        where o.slug like $1 || 'org-%'`,
      [PREFIX, EMAIL_DOMAIN],
    );
    // 5 projects per org, owned alternately by user 0 / user 1 of that org.
    await db.query(
      `insert into projects (name, urls, status, owner_id, org_id, created_at)
       select $1 || 'project-' || lpad(o.n::text, 2, '0') || '-' || p,
              array['https://loadtest-' || o.n || '-' || p || '.example.test/', 'https://loadtest-' || o.n || '-' || p || '.example.test/pricing'],
              'active', (select u.id from users u where u.email = $1 || lpad(o.n::text, 2, '0') || '-u0' || (p % 2) || '@' || $2),
              o.id, now() - interval '95 days'
         from (select id, row_number() over (order by slug)::int as n from organizations where slug like $1 || 'org-%') o,
              generate_series(0, ($3::int / $4::int) - 1) p`,
      [PREFIX, EMAIL_DOMAIN, PROJECTS, ORGS],
    );
    await db.query(
      `insert into pages (project_id, url, title)
       select p.id, u, 'Loadtest page' from projects p, unnest(p.urls) u where p.name like $1 || 'project-%'`,
      [PREFIX],
    );
    // Skewed project sizes: weight 1..10 by project ordinal, so a few projects hold thousands of annotations.
    await db.query(
      `with proj as (
         select p.id, p.org_id, p.owner_id, row_number() over (order by p.name) as rn,
                (1 + (row_number() over (order by p.name) % 10)) as w
           from projects p where p.name like $1 || 'project-%'),
       expanded as (
         select proj.*, g from proj, lateral generate_series(1, (proj.w * $2::int / 550.0)::int) g),
       numbered as (
         select e.*, row_number() over (partition by e.id order by e.g) as pin from expanded e)
       insert into annotations (project_id, org_id, type, severity, status, body, author_id, target, environment,
                                pin_number, page_id, created_at, updated_at)
       select n.id, n.org_id,
              (array['note','note','note','suggestion','suggestion','guideline'])[1 + floor(random()*6)::int],
              (array['critical','major','major','minor','minor','minor','informational','informational'])[1 + floor(random()*8)::int],
              (array['active','active','active','in_progress','resolved','resolved','resolved'])[1 + floor(random()*7)::int],
              'Loadtest feedback #' || n.pin || ': ' || md5(random()::text) || ' the button label is unclear on this page and the spacing looks off',
              n.owner_id,
              jsonb_build_object('cssSelector', 'div.card:nth-child(' || (1 + floor(random()*12)::int) || ') > button', 'xpath', '/html/body/div/button',
                                 'pageX', floor(random()*1280)::int, 'pageY', floor(random()*3000)::int, 'tagName', 'BUTTON', 'textSnippet', 'Buy now'),
              jsonb_build_object('browserFamily', (array['Chrome','Chrome','Chrome','Safari','Firefox','Edge'])[1 + floor(random()*6)::int],
                                 'browserVersion', '120.0', 'osFamily', (array['macOS','Windows','Windows','Linux','iOS'])[1 + floor(random()*5)::int],
                                 'osVersion', '14', 'deviceType', (array['desktop','desktop','mobile','tablet'])[1 + floor(random()*4)::int],
                                 'userAgentRaw', 'Mozilla/5.0 loadtest', 'viewportWidth', 1280, 'viewportHeight', 800),
              n.pin,
              (select pg.id from pages pg where pg.project_id = n.id order by pg.url limit 1 offset (n.pin % 2)),
              now() - (random() * interval '90 days'), now() - (random() * interval '90 days')
         from numbered n`,
      [PREFIX, ANNOTATIONS],
    );
    await db.query(
      `update projects p set pin_counter = coalesce((select max(pin_number) from annotations a where a.project_id = p.id), 0)
        where p.name like $1 || 'project-%'`,
      [PREFIX],
    );
    // Comments: skew towards a subset of annotations (long threads on some, none on most).
    await db.query(
      `with ann as (select a.id, a.org_id, a.project_id, a.created_at, row_number() over (order by a.id) as rn
                      from annotations a join projects p on p.id = a.project_id where p.name like $1 || 'project-%'),
            cnt as (select count(*)::int as c from ann)
       insert into comments (annotation_id, author_id, body, org_id, created_at)
       select a.id, p.owner_id, 'Loadtest comment ' || r.g || ' ' || md5(random()::text), a.org_id,
              a.created_at + (random() * interval '10 days')
         from (select g, 1 + floor(power(random(), 3) * (select c from cnt))::int as rn from generate_series(1, $2::int) g) r
         join ann a on a.rn = r.rn
         join projects p on p.id = a.project_id`,
      [PREFIX, COMMENTS],
    );
    await db.query(
      `insert into audit_logs (org_id, actor_id, action, resource_type, resource_id, metadata, ip_address, created_at)
       select o.id, u.id, (array['annotation.created','annotation.updated','comment.created','project.updated','auth.login'])[1 + floor(random()*5)::int],
              (array['annotation','annotation','comment','project','session'])[1 + floor(random()*5)::int], md5(random()::text), '{}'::jsonb,
              '127.0.0.1', now() - (random() * interval '90 days')
         from generate_series(1, $2) g
         join lateral (select id from organizations where slug like $1 || 'org-%' order by slug offset (g % $3) limit 1) o on true
         join lateral (select id from users where email like $1 || '%@' || $4 order by email offset (g % 7) limit 1) u on true`,
      [PREFIX, AUDIT_ROWS, ORGS, EMAIL_DOMAIN],
    );
    await db.query('commit');
  } catch (err) {
    await db.query('rollback');
    throw err;
  }
  // Widget keys (raw keys are written to .tokens.json, only the hash is stored).
  const keys: { raw: string; projectId: string }[] = [];
  const { rows: projects } = await db.query(
    `select p.id, p.org_id, p.owner_id from projects p where p.name like $1 || 'project-%' order by p.name`,
    [PREFIX],
  );
  await db.query('begin');
  for (let i = 0; i < WIDGET_KEYS; i++) {
    const p = projects[i % projects.length];
    const raw = `pk_widget_${randomBytes(32).toString('hex')}`;
    await db.query(
      `insert into api_keys (org_id, name, key_hash, key_prefix, scopes, created_by, key_type, project_id, allowed_origins, daily_quota)
       values ($1, $2, $3, $4, '{widget}', $5, 'widget', $6, '{}', 1000000)`,
      [p.org_id, `${PREFIX}widget-${i}`, createHash('sha256').update(raw).digest('hex'), raw.slice(0, 18), p.owner_id, p.id],
    );
    keys.push({ raw, projectId: p.id });
  }
  await db.query('commit');
  writeFileSync(join(HERE, '.widget-keys.json'), JSON.stringify(keys), { mode: 0o600 });
  await db.query('analyze');
  log(`Seeded ${ORGS} orgs, ${ORGS * USERS_PER_ORG} users, ${PROJECTS} projects, ~${ANNOTATIONS} annotations, ${COMMENTS} comments, ${AUDIT_ROWS} audit rows, ${WIDGET_KEYS} widget keys in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

async function writeTokens(db: Db): Promise<void> {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET must be set (source $HOME/.pinpoint-dev/env) so tokens match the running API.');
  const { rows } = await db.query(
    `select u.id as user_id, u.email, u.token_version, m.org_id, m.role
       from users u join memberships m on m.user_id = u.id
      where u.email like $1 || '%@' || $2 and u.email ~ '-u0[01]@'
      order by u.email`,
    [PREFIX, EMAIL_DOMAIN],
  );
  const now = Math.floor(Date.now() / 1000);
  const users = [];
  for (const r of rows) {
    const token = jwt.sign(
      { userId: r.user_id, email: r.email, orgId: r.org_id, role: r.role, tokenVersion: r.token_version, sessionStart: now },
      secret,
      { expiresIn: '12h', algorithm: 'HS256' },
    );
    const { rows: projs } = await db.query(
      `select p.id, (select a.id from annotations a left join comments c on c.annotation_id = a.id where a.project_id = p.id
                group by a.id order by count(c.id) desc, a.id limit 1) as annotation_id,
              (select coalesce(array_agg(x.id), '{}') from (select a.id from annotations a where a.project_id = p.id order by a.pin_number limit 20) x) as annotation_ids,
              (select count(*)::int from annotations a where a.project_id = p.id) as annotations,
              (select url from pages g where g.project_id = p.id order by url limit 1) as page_url
         from projects p where p.owner_id = $1 order by p.name`,
      [r.user_id],
    );
    users.push({ email: r.email, userId: r.user_id, orgId: r.org_id, token, projects: projs.map((p) => ({ id: p.id, annotationId: p.annotation_id, annotationIds: p.annotation_ids, annotations: p.annotations, pageUrl: p.page_url })) });
  }
  let widgetKeys: unknown[] = [];
  try {
    widgetKeys = JSON.parse(readFileSync(join(HERE, '.widget-keys.json'), 'utf8'));
  } catch {
    log('  (no .widget-keys.json — widget scenarios will be skipped; run --clean then seed again to regenerate)');
  }
  writeFileSync(TOKENS_FILE, JSON.stringify({ password: LOADTEST_PASSWORD, users, widgetKeys }, null, 1), { mode: 0o600 });
  log(`Wrote ${users.length} session tokens (12h) + ${widgetKeys.length} widget keys to loadtest/.tokens.json`);
}

async function doClean(db: Db): Promise<void> {
  await db.query('begin');
  try {
    const { rows: orgs } = await db.query(`select id from organizations where slug like $1`, [`${PREFIX}%`]);
    const orgIds = orgs.map((o) => o.id);
    const { rows: us } = await db.query(`select id from users where email like $1 and email like $2`, [`${PREFIX}%`, `%@${EMAIL_DOMAIN}`]);
    const userIds = us.map((u) => u.id);
    if (orgIds.length > 0) {
      for (const t of await tablesWithoutFk(db, 'org_id')) {
        if (t === 'organizations') continue;
        await db.query(`delete from "${t}" where org_id = any($1::uuid[])`, [orgIds]);
      }
      await db.query(`delete from projects where org_id = any($1::uuid[])`, [orgIds]); // cascades annotations/comments/pages
      await db.query(`delete from organizations where id = any($1::uuid[])`, [orgIds]);
    }
    if (userIds.length > 0) {
      await db.query(`delete from audit_logs where actor_id = any($1::uuid[])`, [userIds]);
      await db.query(`delete from users where id = any($1::uuid[])`, [userIds]);
    }
    await db.query('commit');
    log(`Cleaned ${orgIds.length} loadtest orgs and ${userIds.length} users.`);
  } catch (err) {
    await db.query('rollback');
    throw err;
  }
  for (const f of [TOKENS_FILE, join(HERE, '.widget-keys.json')]) {
    rmSync(f, { force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`loadtest/seed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
