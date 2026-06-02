import type { Knex } from 'knex';

/**
 * API keys table — org-scoped, hashed keys with scope arrays.
 * The raw key is shown once at creation; only the SHA-256 hash is stored.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('api_keys', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('org_id').notNullable().references('id').inTable('organizations').onDelete('CASCADE');
    t.string('name', 255).notNullable();
    t.string('key_hash', 255).notNullable().unique();
    t.string('key_prefix', 8).notNullable(); // first 8 chars for identification
    t.specificType('scopes', 'text[]').notNullable().defaultTo('{feedback:read,feedback:write}');
    t.uuid('created_by').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.timestamp('last_used_at');
    t.timestamp('revoked_at');
    t.timestamps(true, true);
  });

  await knex.schema.alterTable('api_keys', (t) => {
    t.index(['org_id'], 'idx_api_keys_org');
    t.index(['key_hash'], 'idx_api_keys_hash');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('api_keys');
}
