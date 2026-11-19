// Integration token refresh service (Task 3; hardened by Missions A4 + A5a).
//
// Queries integrations nearing expiry and refreshes their OAuth tokens. Two
// security properties layered on by Batch 1:
//   A4  — `access_token` / `refresh_token` and `config.clientSecret` are
//         stored AES-256-GCM-encrypted. We decrypt on read before talking to
//         the provider and re-encrypt the fresh tokens on write.
//   A5a — the token endpoint is customer/config-controlled, so the outbound
//         refresh POST goes through `safeFetch` (DNS-pinned, https-only,
//         private/metadata ranges blocked) instead of raw `fetch`.

import type { Knex } from 'knex';
import { SecretBox, isEncrypted } from './secretBox.js';
import { safeFetch as defaultSafeFetch, type EgressGuardOptions } from './egressGuard.js';

const MAX_RETRIES = 3;

/**
 * Derive the SecretBox from `INTEGRATION_ENCRYPTION_KEY`, falling back to the
 * same stable dev key as `loadConfigFromEnv`. Used when a caller (e.g. the
 * refresh worker) invokes `refreshExpiredTokens(db)` without an explicit box,
 * so encrypted rows still decrypt correctly.
 */
function defaultSecretBoxFromEnv(): SecretBox {
  const raw =
    process.env.INTEGRATION_ENCRYPTION_KEY ||
    Buffer.from('pinpoint-dev-integration-key-0001').subarray(0, 32).toString('base64');
  return SecretBox.fromRawKey(raw);
}

export interface RefreshOptions {
  /**
   * SecretBox used to decrypt stored secrets and encrypt refreshed ones. When
   * omitted the service runs in pass-through mode (legacy plaintext rows),
   * which keeps older callers working during the migration window.
   */
  secretBox?: SecretBox;
  /** SSRF-safe fetch; defaults to the real egress guard. */
  safeFetch?: typeof defaultSafeFetch;
  /** Egress guard options (e.g. allowHttp in dev). */
  egressOptions?: EgressGuardOptions;
}

/** Decrypt a possibly-encrypted secret; pass through plaintext/empty. */
function readSecret(box: SecretBox | undefined, value: string | null | undefined): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (box && isEncrypted(value)) return box.decrypt(value);
  return value;
}

/** Encrypt a secret for storage when a box is configured; else store as-is. */
function writeSecret(box: SecretBox | undefined, value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return value === '' ? '' : null;
  return box ? box.encrypt(value) : value;
}

export async function refreshExpiredTokens(db: Knex, opts: RefreshOptions = {}): Promise<void> {
  const box = opts.secretBox ?? defaultSecretBoxFromEnv();
  const doFetch = opts.safeFetch ?? defaultSafeFetch;
  const egressOptions = opts.egressOptions ?? {};
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

        const refreshToken = readSecret(box, integration.refresh_token);
        if (!refreshToken) break;
        const clientSecret = readSecret(box, config.clientSecret as string | undefined);

        const res = await doFetch(
          tokenEndpoint,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'refresh_token',
              refresh_token: refreshToken,
              ...(config.clientId ? { client_id: config.clientId as string } : {}),
              ...(clientSecret ? { client_secret: clientSecret } : {}),
            }).toString(),
          },
          egressOptions,
        );

        if (!res.ok) continue;

        const data = (await res.json()) as Record<string, unknown>;
        await db('integrations').where({ id: integration.id }).update({
          access_token: writeSecret(box, data.access_token as string),
          refresh_token: writeSecret(box, (data.refresh_token as string) ?? refreshToken),
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
