import type { Knex } from 'knex';

/**
 * Phase 2 / Task 5.2 — per-project `pin_counter`.
 *
 * Adds a row counter on `projects` so that annotation pin numbers can be assigned
 * race-free via:
 *   UPDATE projects SET pin_counter = pin_counter + 1 WHERE id = $1 RETURNING pin_counter;
 * inside the same transaction as the annotation insert (see Design §8 and Requirement 24).
 *
 * The counter is backfilled from existing annotations so that pin numbers continue
 * monotonically after deploy. Projects with no annotations remain at 0.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('projects', (t) => {
    t.integer('pin_counter').notNullable().defaultTo(0);
  });

  await knex.raw(
    `UPDATE projects p
        SET pin_counter = COALESCE(
          (SELECT MAX(pin_number) FROM annotations a WHERE a.project_id = p.id),
          0
        )`
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('projects', (t) => {
    t.dropColumn('pin_counter');
  });
}
