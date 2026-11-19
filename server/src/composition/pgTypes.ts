import pg from 'pg';

/** Postgres OID of the `date` type. */
const PG_DATE_OID = 1082;

let registered = false;

/**
 * Keep Postgres `date` columns as their plain 'YYYY-MM-DD' string.
 *
 * node-pg's default parser turns a `date` into a JS Date at LOCAL midnight;
 * serialising that with toISOString() shifts it by the server's UTC offset
 * (2026-12-24 -> 2026-12-23T22:00Z east of UTC). A calendar date has no time
 * zone, so we never want it to become an instant. Idempotent: call from the
 * DB setup before opening connections.
 */
export function registerPgTypeParsers(): void {
  if (registered) return;
  registered = true;
  pg.types.setTypeParser(PG_DATE_OID, (value: string) => value);
}
