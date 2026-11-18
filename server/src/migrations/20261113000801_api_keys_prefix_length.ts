import type { Knex } from 'knex';

/**
 * `api_keys.key_prefix` was varchar(8), but identifying prefixes are longer
 * (`pk_` + 8 hex = 11 chars, `pk_widget_` + 8 hex = 18), so key creation
 * failed with Postgres 22001 on a real database. Widen to 32.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE api_keys ALTER COLUMN key_prefix TYPE varchar(32)');
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('UPDATE api_keys SET key_prefix = left(key_prefix, 8)');
  await knex.raw('ALTER TABLE api_keys ALTER COLUMN key_prefix TYPE varchar(8)');
}
