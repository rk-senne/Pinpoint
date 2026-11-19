// OAuth route tests (F-16): signed/provider-bound/expiring state cookie,
// public login initiation, PKCE ordering.

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { createHash, createHmac } from 'node:crypto';
import { request } from '../../../__tests__/supertestClient.js';
import { createOAuthRoutes, signOAuthState, verifyOAuthState } from './oauth.routes.js';
import type { OAuthLogin, OAuthProvider } from '../../../domain/auth/usecases/oauthLogin.js';

const SECRET = 'test-oauth-state-secret-0123456789';
const APP = 'https://app.test';

function build(opts: { now?: () => number; login?: ReturnType<typeof vi.fn> } = {}) {
  const execute =
    opts.login ??
    vi.fn(async () => ({ ok: true, value: { token: 'jwt', csrfToken: 'csrf', user: { id: 'u1' } } }));
  const provider: OAuthProvider = {
    getAuthorizationUrl: (state, redirectUri) => `https://idp.test/auth?state=${state}&ru=${encodeURIComponent(redirectUri)}`,
    exchangeCode: async () => 'at',
    getProfile: async () => ({ id: '1', email: 'a@b.test', name: 'A', emailVerified: true }),
  };
  const router = createOAuthRoutes({
    oauthLogin: { execute } as unknown as OAuthLogin,
    providers: { google: provider, github: provider },
    callbackBaseUrl: 'https://api.test',
    appUrl: APP,
    cookieInsecure: true,
    stateSecret: SECRET,
    ...(opts.now ? { now: opts.now } : {}),
  });
  const app = express();
  app.use(cookieParser());
  app.use('/api/v1/auth/oauth', router);
  return { app, execute };
}

/** Run /google and return { state, cookie } the way a browser would. */
async function initiate(app: express.Express, provider = 'google', query = '') {
  const res = await request(app).get(`/api/v1/auth/oauth/${provider}${query}`);
  expect(res.status).toBe(302);
  const state = new URL(res.headers.location!).searchParams.get('state')!;
  const setCookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const raw = setCookie.find((c) => c.startsWith('oauth_state='))!;
  const cookie = raw.split(';')[0]!;
  return { state, cookie, raw };
}

describe('oauth.routes — login initiation (F-16)', () => {
  it('is PUBLIC: redirects a visitor with no session (no 401)', async () => {
    const { app } = build();
    const { state, raw } = await initiate(app);
    expect(state).toMatch(/^[0-9a-f]{32}$/);
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Lax/i);
    expect(raw).toMatch(/Max-Age=600/i);
    expect(raw).toMatch(/Path=\/api\/v1\/auth\/oauth/);
  });

  it('sets a signed (not plain JSON / not the bare state) cookie', async () => {
    const { app } = build();
    const { state, cookie } = await initiate(app);
    const value = decodeURIComponent(cookie.slice('oauth_state='.length));
    expect(value).not.toContain(state);
    expect(value).toMatch(/^[\w-]+\.[\w-]+$/);
    const payload = verifyOAuthState(SECRET, value, Date.now());
    expect(payload).toMatchObject({ s: state, p: 'google' });
  });
});

describe('oauth.routes — callback state validation (F-16)', () => {
  it('accepts a genuine state and logs in (web flow sets session cookies)', async () => {
    const { app, execute } = build();
    const { state, cookie } = await initiate(app);
    const res = await request(app)
      .get(`/api/v1/auth/oauth/google/callback?code=abc&state=${state}`)
      .set('Cookie', cookie);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(APP);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(([] as string[]).concat(res.headers['set-cookie']).join('\n')).toContain('fl_session=jwt');
  });

  const expectRejected = (res: { status: number; headers: Record<string, string> }, execute: ReturnType<typeof vi.fn>) => {
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${APP}/auth?error=oauth_failed`);
    expect(execute).not.toHaveBeenCalled();
  };

  it('rejects an unsigned / legacy plain-string state cookie', async () => {
    const { app, execute } = build();
    const res = await request(app)
      .get('/api/v1/auth/oauth/google/callback?code=abc&state=deadbeef')
      .set('Cookie', 'oauth_state=deadbeef');
    expectRejected(res, execute);
  });

  it('rejects a cookie signed with the wrong key (forged)', async () => {
    const { app, execute } = build();
    const forged = signOAuthState('attacker-key', { s: 'known', p: 'google', e: Date.now() + 60_000 });
    const res = await request(app)
      .get('/api/v1/auth/oauth/google/callback?code=abc&state=known')
      .set('Cookie', `oauth_state=${encodeURIComponent(forged)}`);
    expectRejected(res, execute);
  });

  it('rejects a tampered payload (MAC no longer matches)', async () => {
    const { app, execute } = build();
    const { state, cookie } = await initiate(app);
    const value = decodeURIComponent(cookie.slice('oauth_state='.length));
    const [body, mac] = value.split('.');
    const payload = JSON.parse(Buffer.from(body!, 'base64url').toString());
    payload.p = 'github';
    const tampered = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${mac}`;
    const res = await request(app)
      .get(`/api/v1/auth/oauth/github/callback?code=abc&state=${state}`)
      .set('Cookie', `oauth_state=${encodeURIComponent(tampered)}`);
    expectRejected(res, execute);
  });

  it('is bound to the provider: a state issued for google cannot complete github', async () => {
    const { app, execute } = build();
    const { state, cookie } = await initiate(app, 'google');
    const res = await request(app)
      .get(`/api/v1/auth/oauth/github/callback?code=abc&state=${state}`)
      .set('Cookie', cookie);
    expectRejected(res, execute);
  });

  it('expires: a state older than its TTL is rejected', async () => {
    let t = 1_000_000;
    const { app, execute } = build({ now: () => t });
    const { state, cookie } = await initiate(app);
    t += 601_000; // > 10 min
    const res = await request(app)
      .get(`/api/v1/auth/oauth/google/callback?code=abc&state=${state}`)
      .set('Cookie', cookie);
    expectRejected(res, execute);
  });

  it('rejects a mismatched state query param and a missing cookie', async () => {
    const { app, execute } = build();
    const { cookie } = await initiate(app);
    const bad = await request(app)
      .get('/api/v1/auth/oauth/google/callback?code=abc&state=nope')
      .set('Cookie', cookie);
    expectRejected(bad, execute);
    const none = await request(app).get('/api/v1/auth/oauth/google/callback?code=abc&state=nope');
    expectRejected(none, execute);
  });

  it('clears the state cookie on callback (single use)', async () => {
    const { app } = build();
    const { state, cookie } = await initiate(app);
    const res = await request(app)
      .get(`/api/v1/auth/oauth/google/callback?code=abc&state=${state}`)
      .set('Cookie', cookie);
    const cleared = ([] as string[]).concat(res.headers['set-cookie']).find((c) => c.startsWith('oauth_state='));
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(cleared).toMatch(/Path=\/api\/v1\/auth\/oauth/);
  });
});

describe('oauth.routes — PKCE (mobile) ordering', () => {
  const verifier = 'v'.repeat(48);
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  it('returns JSON token on a valid verifier', async () => {
    const { app } = build();
    const { state, cookie } = await initiate(app, 'google', `?code_challenge=${challenge}`);
    const res = await request(app)
      .get(`/api/v1/auth/oauth/google/callback?code=abc&state=${state}&code_verifier=${verifier}`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.token).toBe('jwt');
  });

  it('a wrong verifier is rejected BEFORE the login use case runs (no account created/linked)', async () => {
    const { app, execute } = build();
    const { state, cookie } = await initiate(app, 'google', `?code_challenge=${challenge}`);
    const res = await request(app)
      .get(`/api/v1/auth/oauth/google/callback?code=abc&state=${state}&code_verifier=wrong`)
      .set('Cookie', cookie);
    expect(res.status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('verifyOAuthState', () => {
  it('uses HMAC-SHA256 over the base64url payload', () => {
    const payload = { s: 'x', p: 'google', e: 10_000 };
    const signed = signOAuthState(SECRET, payload);
    const [body, mac] = signed.split('.');
    expect(mac).toBe(createHmac('sha256', SECRET).update(body!).digest('base64url'));
    expect(verifyOAuthState(SECRET, signed, 5_000)).toEqual(payload);
    expect(verifyOAuthState(SECRET, signed, 10_000)).toBeNull();
    expect(verifyOAuthState(SECRET, 'garbage', 0)).toBeNull();
    expect(verifyOAuthState(SECRET, undefined, 0)).toBeNull();
  });
});
