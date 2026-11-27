/**
 * Log the seeded account in ONCE per run and persist the cookie jar to
 * `.auth/seed.json`. Every APIRequestContext created by the specs loads it
 * via `use.storageState`, so specs share one session instead of each
 * logging in (which trips the API's 5-per-minute auth rate limit, Req 19.1).
 *
 * The CSRF token is persisted alongside (it's in the readable `fl_csrf`
 * cookie, but the helper needs it without parsing cookies).
 */
import { request, type FullConfig } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const STORAGE_STATE = '.auth/seed.json';
export const SESSION_META = '.auth/seed-session.json';

export default async function globalSetup(_config: FullConfig): Promise<void> {
  mkdirSync(dirname(STORAGE_STATE), { recursive: true });
  const email = process.env.FL_E2E_EMAIL;
  const password = process.env.FL_E2E_PASSWORD;
  const api = process.env.FL_API_URL ?? 'http://localhost:3001';
  const ctx = await request.newContext();
  try {
    if (email && password) {
      const health = await ctx.get(`${api}/health`, { timeout: 2_000 }).catch(() => null);
      if (health?.ok()) {
        const res = await ctx.post(`${api}/api/v1/auth/login`, { data: { email, password } });
        if (res.ok()) {
          const body = await res.json();
          writeFileSync(SESSION_META, JSON.stringify({ email: email.toLowerCase(), body }));
          await ctx.storageState({ path: STORAGE_STATE });
          return;
        }
        throw new Error(`e2e globalSetup: seed login failed ${res.status()} ${await res.text()}`);
      }
    }
    // No stack / no seed creds: write an empty state so `storageState` loads.
    writeFileSync(STORAGE_STATE, JSON.stringify({ cookies: [], origins: [] }));
    writeFileSync(SESSION_META, JSON.stringify(null));
  } finally {
    await ctx.dispose();
  }
}
