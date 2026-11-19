import type { Knex } from 'knex';

// Inlined (not imported from services/standardWebhooks) so this migration is
// self-contained: ts-node can't resolve the app's NodeNext `.js` specifiers,
// and migrations must stay frozen as app code evolves.
const WHSEC_PREFIX = 'whsec_';

/**
 * Mission A5b — standard-webhooks signing + durable queued dispatch.
 *
 * Two changes:
 *
 *  1. Durable delivery queue. The old `webhook_deliveries` table was a
 *     write-only audit log appended AFTER a (fire-and-forget) attempt. A
 *     SIGTERM mid-backoff dropped the delivery. This migration turns it into
 *     a durable queue mirroring the notification queue:
 *       - `status` ('pending' | 'sent' | 'failed'), default 'pending'
 *       - `attempts` integer, default 0
 *       - `scheduled_at` — when the row becomes eligible for a claim
 *       - `msg_id` — stable per-delivery id emitted as `webhook-id` so a
 *         consumer can dedupe across retries
 *       - `last_error` — last failure message
 *     A partial index on (scheduled_at) WHERE status='pending' keeps the
 *     worker's `FOR UPDATE SKIP LOCKED` claim cheap. Existing audit rows are
 *     backfilled to a terminal status so the worker never re-sends history.
 *
 *  2. `whsec_` secret migration. Pre-A5b endpoints stored a 64-char hex
 *     secret and signed the raw body only. New endpoints mint a
 *     `whsec_`-prefixed base64 secret. This migration wraps any legacy secret
 *     in the `whsec_` prefix form by base64-encoding its bytes so every row
 *     is Standard-Webhooks shaped going forward; `secretKeyBytes` still
 *     decodes it. Idempotent: rows already prefixed are left untouched.
 */

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('webhook_deliveries', (t) => {
    t.string('status', 16).notNullable().defaultTo('pending');
    t.integer('attempts').notNullable().defaultTo(0);
    t.timestamp('scheduled_at').notNullable().defaultTo(knex.fn.now());
    t.string('msg_id', 64);
    t.text('last_error');
  });

  // Existing audit rows predate the durable queue — mark them terminal so the
  // worker's pending-claim never resurrects them. success→sent, else→failed.
  await knex('webhook_deliveries')
    .whereNull('status')
    .orWhere('status', 'pending')
    .update({
      status: knex.raw(`CASE WHEN success THEN 'sent' ELSE 'failed' END`),
    });

  // Partial index for the hot claim path (pending rows ordered by schedule).
  await knex.raw(
    `CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_claim
       ON webhook_deliveries (scheduled_at)
       WHERE status = 'pending'`,
  );

  // Migrate legacy endpoint secrets to whsec_ form. Encode the legacy bytes as
  // base64 behind the prefix; secretKeyBytes base64-decodes it, so the derived
  // HMAC key is byte-identical to the legacy UTF-8 key — existing consumers
  // that re-derive from the stored secret keep verifying.
  const endpoints = await knex('webhook_endpoints').select('id', 'secret');
  for (const ep of endpoints) {
    if (typeof ep.secret === 'string' && !ep.secret.startsWith(WHSEC_PREFIX)) {
      const migrated = WHSEC_PREFIX + Buffer.from(ep.secret, 'utf8').toString('base64');
      await knex('webhook_endpoints').where({ id: ep.id }).update({ secret: migrated });
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS idx_webhook_deliveries_claim');
  await knex.schema.alterTable('webhook_deliveries', (t) => {
    t.dropColumn('status');
    t.dropColumn('attempts');
    t.dropColumn('scheduled_at');
    t.dropColumn('msg_id');
    t.dropColumn('last_error');
  });

  // Reverse the secret migration: strip the whsec_ prefix and base64-decode
  // back to the legacy UTF-8 secret when it round-trips cleanly.
  const endpoints = await knex('webhook_endpoints').select('id', 'secret');
  for (const ep of endpoints) {
    if (typeof ep.secret === 'string' && ep.secret.startsWith(WHSEC_PREFIX)) {
      const decoded = Buffer.from(ep.secret.slice(WHSEC_PREFIX.length), 'base64').toString('utf8');
      // Only reverse values that were originally legacy (re-encoding matches).
      const reencoded = WHSEC_PREFIX + Buffer.from(decoded, 'utf8').toString('base64');
      if (reencoded === ep.secret) {
        await knex('webhook_endpoints').where({ id: ep.id }).update({ secret: decoded });
      }
    }
  }
}
