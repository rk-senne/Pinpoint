/**
 * Shared helpers for the local demo / maintenance scripts.
 *
 * These scripts mutate the database directly (verify users, set plans, delete
 * test data), so every one of them refuses to run against anything that is not
 * a local Postgres. Run them with plain Node (>= 22.18 strips TypeScript types
 * natively), e.g. via `npm run demo:seed`.
 */
import pg from 'pg';

export interface DbConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export function dbConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DbConfig {
  return {
    host: env.DB_HOST || 'localhost',
    port: Number(env.DB_PORT || 5432),
    database: env.DB_NAME || 'pinpoint',
    user: env.DB_USER || 'postgres',
    password: env.DB_PASSWORD || 'postgres',
  };
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const ALLOWED_DBS = new Set(['pinpoint', 'pinpoint_test']);

/** Throws unless the target is a local `pinpoint` / `pinpoint_test` database. */
export function assertLocalDb(cfg: DbConfig, opts: { requireKnownName?: boolean } = {}): void {
  if (!LOCAL_HOSTS.has(cfg.host)) {
    throw new Error(`Refusing to run: DB_HOST is "${cfg.host}" (must be 127.0.0.1 or localhost).`);
  }
  if (opts.requireKnownName !== false && !ALLOWED_DBS.has(cfg.database)) {
    throw new Error(`Refusing to run: DB_NAME is "${cfg.database}" (must be pinpoint or pinpoint_test).`);
  }
}

export function connectDb(cfg: DbConfig): pg.Client {
  return new pg.Client(cfg);
}

/**
 * Tables that carry `column` (org_id / project_id) WITHOUT a foreign key on it,
 * so deleting the parent row does not cascade. Discovered from the catalog so
 * the scripts keep working as new tables are added.
 */
export async function tablesWithoutFk(db: pg.Client, column: string): Promise<string[]> {
  const { rows } = await db.query<{ table_name: string }>(
    `select c.table_name
       from information_schema.columns c
       join information_schema.tables t
         on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
      where c.table_schema = 'public' and c.column_name = $1
        and not exists (
          select 1 from pg_constraint k
           where k.conrelid = format('%I.%I', c.table_schema, c.table_name)::regclass
             and k.contype = 'f'
             and (select a.attname from pg_attribute a where a.attrelid = k.conrelid and a.attnum = k.conkey[1]) = c.column_name
        )
      order by 1`,
    [column],
  );
  return rows.map((r) => r.table_name);
}

// Piping into `head` etc. must not crash the script with an unhandled EPIPE.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

export function log(msg = ''): void {
  process.stdout.write(`${msg}\n`);
}
