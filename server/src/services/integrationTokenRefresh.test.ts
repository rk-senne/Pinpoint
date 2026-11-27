import { describe, it, expect, vi } from 'vitest';
import { refreshExpiredTokens } from './integrationTokenRefresh.js';
import { SecretBox, isEncrypted } from './secretBox.js';

const box = SecretBox.fromRawKey('a'.repeat(64));

/**
 * Minimal chainable + thenable Knex mock. The expiring-rows query resolves to
 * `rows`; subsequent `.where(...).update(payload)` calls are captured.
 */
function makeMockDb(rows: Array<Record<string, unknown>>) {
  const updates: Array<{ where: unknown; payload: Record<string, unknown> }> = [];

  const db: any = vi.fn((_table: string) => {
    let whereArg: unknown;
    const b: any = {
      where: (arg: unknown) => {
        whereArg = arg;
        return b;
      },
      whereNotNull: () => b,
      update: (payload: Record<string, unknown>) => {
        updates.push({ where: whereArg, payload });
        return Promise.resolve(1);
      },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(rows).then(res, rej),
    };
    return b;
  });
  db.fn = { now: () => 'NOW()' };

  return { db, updates };
}

function okJson(data: Record<string, unknown>) {
  return { ok: true, status: 200, json: async () => data, text: async () => '' };
}

describe('refreshExpiredTokens (A4 + A5a)', () => {
  it('decrypts the stored refresh token before calling the provider and re-encrypts on write', async () => {
    const encRefresh = box.encrypt('plain-refresh-token');
    const encClientSecret = box.encrypt('plain-client-secret');

    const rows = [
      {
        id: 'int-1',
        refresh_token: encRefresh,
        config: JSON.stringify({
          tokenEndpoint: 'https://idp.example.com/token',
          clientId: 'cid',
          clientSecret: encClientSecret,
        }),
      },
    ];
    const { db, updates } = makeMockDb(rows);

    const safeFetch = vi.fn(async (_url: string, init: any) =>
      okJson({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }),
    ) as any;

    await refreshExpiredTokens(db, { secretBox: box, safeFetch });

    // The outbound body carried the DECRYPTED secrets, never the ciphertext.
    expect(safeFetch).toHaveBeenCalledOnce();
    const body = safeFetch.mock.calls[0][1].body as string;
    expect(body).toContain('refresh_token=plain-refresh-token');
    expect(body).toContain('client_secret=plain-client-secret');
    expect(body).not.toContain(encRefresh);

    // The persisted tokens are re-ENCRYPTED.
    expect(updates).toHaveLength(1);
    const payload = updates[0].payload;
    expect(isEncrypted(payload.access_token as string)).toBe(true);
    expect(isEncrypted(payload.refresh_token as string)).toBe(true);
    expect(box.decrypt(payload.access_token as string)).toBe('new-access');
    expect(box.decrypt(payload.refresh_token as string)).toBe('new-refresh');
  });

  it('disables the integration when every refresh attempt fails', async () => {
    const rows = [
      {
        id: 'int-2',
        refresh_token: box.encrypt('rt'),
        config: JSON.stringify({ tokenEndpoint: 'https://idp.example.com/token' }),
      },
    ];
    const { db, updates } = makeMockDb(rows);
    const safeFetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => '' })) as any;

    await refreshExpiredTokens(db, { secretBox: box, safeFetch });

    expect(updates).toHaveLength(1);
    expect(updates[0].payload.enabled).toBe(false);
  });

  it('routes the outbound request through the injected safeFetch (SSRF guard)', async () => {
    const rows = [
      {
        id: 'int-3',
        refresh_token: box.encrypt('rt'),
        config: JSON.stringify({ tokenEndpoint: 'https://idp.example.com/token' }),
      },
    ];
    const { db } = makeMockDb(rows);
    const safeFetch = vi.fn(async () => okJson({ access_token: 'a' })) as any;

    await refreshExpiredTokens(db, { secretBox: box, safeFetch });

    expect(safeFetch).toHaveBeenCalledWith(
      'https://idp.example.com/token',
      expect.objectContaining({ method: 'POST' }),
      expect.anything(),
    );
  });
});
