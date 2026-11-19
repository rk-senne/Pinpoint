/**
 * Removes leftover test projects from the LOCAL `pinpoint` database.
 *
 *   npm run demo:clean-test-data            dry run (default): list what would go
 *   npm run demo:clean-test-data -- --yes   actually delete
 *
 * A project is deleted only if BOTH hold:
 *   1. its owner is the e2e seed account or any `*@example.test` /
 *      `*@*.example.test` user, and
 *   2. its name matches a known test-name pattern (browser-*, ext-*, e2e-*,
 *      ext-ondemand-*, mcp-target, probe / st-probe*, Shared probe, …).
 * Demo projects ("Acme Marketing Site", "Northwind Client Portal") never match.
 *
 * Projects created in the last 15 minutes are skipped (a parallel test run may
 * still be using them); override with `--min-age-minutes=N`.
 *
 * Refuses to run unless DB_HOST is 127.0.0.1/localhost and DB_NAME is
 * pinpoint or pinpoint_test.
 */
import { assertLocalDb, connectDb, dbConfigFromEnv, log, tablesWithoutFk } from './lib/common.mts';

const SEED_EMAIL = 'e2e-seed@example.test';

/** POSIX regexes (Postgres `~*`), matched against the whole project name. */
const NAME_PATTERNS = [
  '^(browser|ext|e2e|st|mcp|pw|api)-.+',
  '^ext-ondemand(-.*)?$',
  '^shared[ -]probe.*',
  '^(st-)?probe[0-9]*$',
  '^(Spring launch|Due|Replay|Detail|Smoke|Rename|Renamed|Archive|Export|Probe|Board|Triage)[ -][A-Za-z0-9-]*$',
  '^(after-reload|shape|renamed|p|probe|smoke)$',
];

const OWNER_CLAUSE = `(u.email = $1 or u.email like '%@example.test' or u.email like '%.example.test')`;
const NAME_CLAUSE = `p.name ~* any($2::text[])`;
/** Projects younger than this may belong to a test run still in flight. */
const minAgeArg = process.argv.find((a) => a.startsWith('--min-age-minutes='));
const MIN_AGE_MINUTES = minAgeArg ? Math.max(0, Number(minAgeArg.split('=')[1])) : 15;

async function main(): Promise<void> {
  const yes = process.argv.includes('--yes');
  const cfg = dbConfigFromEnv();
  assertLocalDb(cfg);
  const db = connectDb(cfg);
  await db.connect();
  try {
    log(`${yes ? 'DELETE' : 'DRY RUN'}: ${cfg.host}:${cfg.port}/${cfg.database}`);
    const { rows: matches } = await db.query<{ id: string; name: string; email: string; annotations: string }>(
      `select p.id, p.name, u.email,
              (select count(*) from annotations a where a.project_id = p.id) as annotations
         from projects p join users u on u.id = p.owner_id
        where ${OWNER_CLAUSE} and ${NAME_CLAUSE}
          and p.created_at < now() - make_interval(mins => $3)
        order by p.created_at`,
      [SEED_EMAIL, NAME_PATTERNS, MIN_AGE_MINUTES],
    );
    const total = Number((await db.query(`select count(*) from projects`)).rows[0].count);
    const annotations = matches.reduce((n, m) => n + Number(m.annotations), 0);

    const byPattern = new Map<string, number>();
    for (const m of matches) {
      const key = m.name.replace(/[0-9]{5,}/g, '*').replace(/-[a-z0-9]{5}$/, '-*').replace(/(-\*)+/g, '-*');
      byPattern.set(key, (byPattern.get(key) ?? 0) + 1);
    }
    for (const [k, n] of [...byPattern].sort((a, b) => b[1] - a[1])) log(`  ${String(n).padStart(4)}  ${k}`);
    log(`Matched ${matches.length} of ${total} projects (${annotations} annotations)`);
    log(`Kept (non-matching) projects: ${total - matches.length}`);

    if (!yes) {
      log('Nothing deleted. Re-run with --yes to delete these projects.');
      return;
    }
    if (matches.length === 0) return;

    const ids = matches.map((m) => m.id);
    await db.query('begin');
    try {
      // Project-scoped tables with no FK (portals, rules, boards, …) do not cascade.
      for (const t of await tablesWithoutFk(db, 'project_id')) {
        const r = await db.query(`delete from "${t}" where project_id = any($1::uuid[])`, [ids]);
        if (r.rowCount) log(`  deleted ${r.rowCount} from ${t}`);
      }
      const del = await db.query(`delete from projects where id = any($1::uuid[])`, [ids]);
      await db.query('commit');
      log(`Deleted ${del.rowCount} projects (annotations, comments, pages, shared links cascade).`);
    } catch (err) {
      await db.query('rollback');
      throw err;
    }
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  process.stderr.write(`demo-clean-test-data: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
