// Integration token refresh service (Task 3).
// Queries integrations nearing expiry and refreshes their OAuth tokens.

import type { Knex } from 'knex';

const MAX_RETRIES = 3;

export async function refreshExpiredTokens(db: Knex): Promise<void> {
  const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);

  const expiring = await db('integrations')
    .where('enabled', true)
    .whereNotNull('token_expires_at')
    .where('token_expires_at', '<', fiveMinutesFromNow)
    .whereNotNull('refresh_token');

  for (const integration of expiring) {
    let success = false;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const config = typeof integration.config === 'string'
          ? JSON.parse(integration.config) : (integration.config ?? {});
        const tokenEndpoint = config.tokenEndpoint as string | undefined;
        if (!tokenEndpoint) break;

        const res = await fetch(tokenEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: integration.refresh_token,
            ...(config.clientId ? { client_id: config.clientId as string } : {}),
            ...(config.clientSecret ? { client_secret: config.clientSecret as string } : {}),
          }),
        });

        if (!res.ok) continue;

        const data = (await res.json()) as Record<string, unknown>;
        await db('integrations').where({ id: integration.id }).update({
          access_token: data.access_token as string,
          refresh_token: (data.refresh_token as string) ?? integration.refresh_token,
          token_expires_at: data.expires_in
            ? new Date(Date.now() + (data.expires_in as number) * 1000)
            : null,
          updated_at: db.fn.now(),
        });
        success = true;
        break;
      } catch {
        // retry
      }
    }

    if (!success) {
      await db('integrations').where({ id: integration.id }).update({ enabled: false, updated_at: db.fn.now() });
    }
  }
}
