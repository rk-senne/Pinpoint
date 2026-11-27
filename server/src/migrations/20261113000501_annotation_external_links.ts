import type { Knex } from 'knex';

/**
 * C4 — one-click annotation → trackable task delivery.
 *
 * `annotation_external_links` records each delivery of an annotation to an
 * external tracker (GitHub/Linear/Jira/ClickUp/Asana). The UNIQUE constraint
 * on (annotation_id, provider) makes re-delivery idempotent: the deliver
 * route upserts and returns the existing link instead of opening a duplicate
 * issue. `status` tracks the delivery lifecycle:
 *   - 'delivered' — created successfully; `external_id`/`external_url` set
 *   - 'failed'    — last attempt failed; `last_error` set, re-POST to retry
 *
 * `last_error` never contains the provider access token (adapters map errors
 * to a sanitized message before it reaches here).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('annotation_external_links', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('annotation_id').notNullable()
      .references('id').inTable('annotations').onDelete('CASCADE');
    t.string('provider', 32).notNullable();
    t.string('external_id', 255);
    t.text('external_url');
    t.string('status', 16).notNullable().defaultTo('failed');
    t.text('last_error');
    t.timestamps(true, true);

    t.unique(['annotation_id', 'provider'], {
      indexName: 'uq_annotation_external_links_annotation_provider',
    });
    t.index(['annotation_id'], 'idx_annotation_external_links_annotation');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('annotation_external_links');
}
