import type { Knex } from 'knex';

/**
 * Introduce the `pages` table as a first-class entity (Req 23.1) and
 * rewire `annotations.page_url` (free-text) → `annotations.page_id`
 * (FK to `pages.id`) (Reqs 23.2, 23.3).
 *
 * Up:
 *   1. Create `pages (id, project_id, url, title, created_at)` with UNIQUE (project_id, url).
 *   2. Backfill one `pages` row per distinct (project_id, page_url) seen on `annotations`.
 *   3. Add `annotations.page_id` (initially nullable so we can populate it),
 *      copy ids from the new pages rows, then enforce NOT NULL.
 *   4. Drop the legacy `annotations.page_url` column.
 *
 * Down:
 *   1. Re-add `annotations.page_url` (initially nullable).
 *   2. Copy `pages.url` into `annotations.page_url` via the page_id FK, then enforce NOT NULL.
 *   3. Drop `annotations.page_id`.
 *   4. Drop the `pages` table.
 */
export async function up(knex: Knex): Promise<void> {
  // 1) Create the pages table.
  await knex.schema.createTable('pages', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('project_id').notNullable().references('id').inTable('projects').onDelete('CASCADE');
    t.string('url', 2048).notNullable();
    t.string('title', 512);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.unique(['project_id', 'url'], { indexName: 'pages_project_url_unique' });
  });

  // 2) Backfill: one page row per distinct (project_id, page_url) on annotations.
  //    Earliest annotation timestamp wins for `created_at`.
  await knex.raw(`
    INSERT INTO pages (id, project_id, url, title, created_at)
    SELECT uuid_generate_v4(), a.project_id, a.page_url, NULL, MIN(a.created_at)
    FROM annotations a
    WHERE a.page_url IS NOT NULL
    GROUP BY a.project_id, a.page_url
    ON CONFLICT (project_id, url) DO NOTHING
  `);

  // 3) Add annotations.page_id (nullable for the copy step), then wire it up.
  await knex.schema.alterTable('annotations', (t) => {
    t.uuid('page_id').references('id').inTable('pages').onDelete('CASCADE');
  });

  await knex.raw(`
    UPDATE annotations a
    SET page_id = p.id
    FROM pages p
    WHERE p.project_id = a.project_id
      AND p.url = a.page_url
  `);

  // Lock down: page_id is required from now on.
  await knex.schema.alterTable('annotations', (t) => {
    t.uuid('page_id').notNullable().alter();
  });

  // 4) Drop the legacy page_url column.
  await knex.schema.alterTable('annotations', (t) => {
    t.dropColumn('page_url');
  });
}

export async function down(knex: Knex): Promise<void> {
  // 1) Re-add page_url as nullable so we can copy values into it.
  await knex.schema.alterTable('annotations', (t) => {
    t.string('page_url', 2048);
  });

  // 2) Copy pages.url back onto annotations.page_url.
  await knex.raw(`
    UPDATE annotations a
    SET page_url = p.url
    FROM pages p
    WHERE p.id = a.page_id
  `);

  await knex.schema.alterTable('annotations', (t) => {
    t.string('page_url', 2048).notNullable().alter();
  });

  // 3) Drop the page_id column.
  await knex.schema.alterTable('annotations', (t) => {
    t.dropColumn('page_id');
  });

  // 4) Drop the pages table.
  await knex.schema.dropTableIfExists('pages');
}
