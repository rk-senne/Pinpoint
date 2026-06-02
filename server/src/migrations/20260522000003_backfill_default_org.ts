import type { Knex } from 'knex';

/**
 * Backfill: create a default organization, assign all existing users as owners,
 * and set org_id on projects, annotations, and comments from their ownership chain.
 *
 * This is an expand-contract step — columns remain nullable until backfill runs,
 * then a subsequent migration can add NOT NULL constraints.
 */
export async function up(knex: Knex): Promise<void> {
  // Create default org
  const [defaultOrg] = await knex('organizations')
    .insert({
      name: 'Default Organization',
      slug: 'default',
      plan: 'free',
    })
    .returning('id');

  const orgId = defaultOrg.id;

  // Assign all existing users as owners of the default org
  const users = await knex('users').select('id');
  if (users.length > 0) {
    await knex('memberships').insert(
      users.map((u) => ({
        org_id: orgId,
        user_id: u.id,
        role: 'owner',
        accepted_at: knex.fn.now(),
      })),
    );
  }

  // Backfill org_id on projects
  await knex('projects').whereNull('org_id').update({ org_id: orgId });

  // Backfill org_id on annotations
  await knex('annotations').whereNull('org_id').update({ org_id: orgId });

  // Backfill org_id on comments
  await knex('comments').whereNull('org_id').update({ org_id: orgId });
}

export async function down(knex: Knex): Promise<void> {
  // Clear backfilled org_id values
  await knex('comments').update({ org_id: null });
  await knex('annotations').update({ org_id: null });
  await knex('projects').update({ org_id: null });

  // Remove memberships and default org
  const defaultOrg = await knex('organizations').where({ slug: 'default' }).first();
  if (defaultOrg) {
    await knex('memberships').where({ org_id: defaultOrg.id }).del();
    await knex('organizations').where({ id: defaultOrg.id }).del();
  }
}
