import type { Knex } from 'knex';

/**
 * White-label extension — adds custom domain + full brand customization
 * to client_portals so agencies can serve the portal on their own domain.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('client_portals', (t) => {
    t.string('custom_domain', 255);
    t.string('favicon_url', 2048);
    t.string('font_family', 100);
    t.jsonb('custom_css'); // { buttonStyle: '...', headerBg: '...' }
    t.boolean('hide_pinpoint_branding').defaultTo(false);
    t.string('support_email', 255);
    t.string('company_name', 255);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('client_portals', (t) => {
    t.dropColumn('custom_domain');
    t.dropColumn('favicon_url');
    t.dropColumn('font_family');
    t.dropColumn('custom_css');
    t.dropColumn('hide_pinpoint_branding');
    t.dropColumn('support_email');
    t.dropColumn('company_name');
  });
}
