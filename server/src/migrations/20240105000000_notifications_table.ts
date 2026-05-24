import type { Knex } from 'knex';

/**
 * Migration 5.4: Durable notification queue
 *
 * Creates the `notifications` table that backs the polled Postgres queue
 * described in design key decision #13. Worker processes select pending
 * rows with `FOR UPDATE SKIP LOCKED` and dispatch them; failures are
 * retried with exponential backoff per Requirement 28.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('notifications', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.string('status', 20).notNullable().defaultTo('pending');
    t.integer('attempts').notNullable().defaultTo(0);
    t.jsonb('payload').notNullable();
    t.timestamp('scheduled_at').notNullable().defaultTo(knex.fn.now());
    t.text('last_error');
    t.timestamps(true, true);

    // Status whitelist mirrors NotificationStatus = 'pending' | 'sent' | 'failed'.
    t.check("status IN ('pending','sent','failed')", [], 'notifications_status_check');

    // Composite index supports the worker's poll query
    //   WHERE status='pending' AND scheduled_at <= now() ORDER BY scheduled_at
    t.index(['status', 'scheduled_at'], 'idx_notifications_status_scheduled_at');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('notifications');
}
