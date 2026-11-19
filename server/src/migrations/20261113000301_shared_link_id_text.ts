import type { Knex } from 'knex';

/**
 * Mission A7.2 — widen `shared_links.id` so new, ≥128-bit unguessable link
 * ids (`crypto.randomBytes(16)` base64url, 22 chars) fit.
 *
 * The column was `uuid` with a `uuid_generate_v4()` default. base64url
 * tokens are NOT valid UUIDs, so the column type must change to `text`.
 * Existing UUID rows keep working unchanged — a UUID is a valid `text`
 * value, so the `USING id::text` cast is loss-free and every pre-existing
 * shared link resolves exactly as before.
 *
 * We retain a server-side default so an insert that omits `id` still gets a
 * value (the create use case always supplies a base64url id now, but the
 * default keeps the schema self-consistent and backwards compatible with
 * any caller that relied on the DB to mint the id). The default is cast to
 * text to match the new column type.
 */
export async function up(knex: Knex): Promise<void> {
  // Drop the uuid default before changing the type, then re-add a
  // text-typed default so the column stays self-populating.
  await knex.raw('ALTER TABLE shared_links ALTER COLUMN id DROP DEFAULT');
  await knex.raw(
    'ALTER TABLE shared_links ALTER COLUMN id TYPE text USING id::text',
  );
  await knex.raw(
    "ALTER TABLE shared_links ALTER COLUMN id SET DEFAULT uuid_generate_v4()::text",
  );
}

export async function down(knex: Knex): Promise<void> {
  // Revert to a uuid column. This only succeeds if every id is a
  // well-formed UUID; base64url ids minted while the migration was applied
  // would block the cast, which is the expected safety behaviour for a
  // down-migration on a security-hardening change.
  await knex.raw('ALTER TABLE shared_links ALTER COLUMN id DROP DEFAULT');
  await knex.raw(
    'ALTER TABLE shared_links ALTER COLUMN id TYPE uuid USING id::uuid',
  );
  await knex.raw(
    'ALTER TABLE shared_links ALTER COLUMN id SET DEFAULT uuid_generate_v4()',
  );
}
