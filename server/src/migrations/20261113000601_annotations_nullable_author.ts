import type { Knex } from 'knex';

/**
 * Guest/widget annotations have no user account.
 *
 * `annotations.author_id` was `uuid NOT NULL REFERENCES users(id)`, so the
 * guest-link and embeddable-widget submission paths (which have no author)
 * could not insert at all against a real database. Guest rows are already
 * identified by `is_guest` / `guest_name` / `guest_email`; this makes
 * `author_id` nullable so they carry `NULL` instead of a fake user id.
 *
 * Invariant (CHECK): a row has an author XOR is a guest row — authenticated
 * rows keep a real FK'd author, guest rows have none.
 *
 * down(): rows with a NULL author cannot satisfy NOT NULL, so they are
 * deleted before the constraint is restored. That data loss is inherent to
 * reverting the feature and only affects guest/widget submissions.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE annotations ALTER COLUMN author_id DROP NOT NULL');
  await knex.raw(`
    ALTER TABLE annotations
      ADD CONSTRAINT annotations_author_or_guest
      CHECK ((author_id IS NOT NULL) <> is_guest)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE annotations DROP CONSTRAINT IF EXISTS annotations_author_or_guest');
  await knex('annotations').whereNull('author_id').del();
  await knex.raw('ALTER TABLE annotations ALTER COLUMN author_id SET NOT NULL');
}
