import type { Knex } from 'knex';

/**
 * Webhook delivery claim lease.
 *
 * The original claim was `SELECT … FOR UPDATE SKIP LOCKED` inside a short
 * transaction that committed before the HTTP send, so the row locks were
 * released while rows were still `pending` — concurrent workers (and the
 * next poll tick during a slow send) re-claimed and re-sent the same
 * deliveries. The claim now atomically flips rows to `processing` with a
 * `locked_until` lease; an expired lease (crashed worker) makes the row
 * claimable again, preserving at-least-once delivery without duplicates
 * under normal operation.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('webhook_deliveries', (t) => {
    t.timestamp('locked_until', { useTz: true }).nullable();
  });
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_processing_lease
      ON webhook_deliveries (locked_until)
      WHERE status = 'processing'
  `);
}

export async function down(knex: Knex): Promise<void> {
  // Return any in-flight rows to the queue so nothing is stranded.
  await knex('webhook_deliveries').where({ status: 'processing' }).update({ status: 'pending' });
  await knex.raw('DROP INDEX IF EXISTS idx_webhook_deliveries_processing_lease');
  await knex.schema.alterTable('webhook_deliveries', (t) => {
    t.dropColumn('locked_until');
  });
}
