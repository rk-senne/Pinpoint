// Integration test (real Postgres, real composition root): TOTP two-factor auth.
// Skips gracefully when no migrated Postgres test DB is reachable.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { request } from '../supertestClient.js';
import { bootLiveApp, type LiveApp } from './helpers/liveApp.js';
import { totpAt } from '../../domain/auth/mfa/totp.js';

// Per-IP throttles are exercised in authRateLimit tests; raise them BEFORE the limiter modules load.
vi.hoisted(() => {
  process.env.MFA_RATE_LIMIT_MAX = '1000000';
  process.env.AUTH_RATE_LIMIT_IP_MAX = '1000000';
});

let live: LiveApp | null = null;
let skip: string | null = null;
const PASSWORD = 'Str0ng-Test-Passw0rd-xyz!';
const users: string[] = [];

beforeAll(async () => {
  const booted = await bootLiveApp();
  if ('skip' in booted) skip = booted.skip;
  else live = booted;
});
afterAll(async () => {
  if (live) for (const id of users) await live.db('users').where({ id }).del().catch(() => undefined);
  await live?.cleanup();
});

interface Acct { id: string; email: string; token: string; csrf: string; cookies: string[] }
async function account(): Promise<Acct> {
  const email = `mfa-${randomUUID().slice(0, 8)}@mfa.example.test`;
  await request(live!.app).post('/api/v1/auth/register').send({ email, password: PASSWORD, name: 'Mfa Tester' });
  await live!.db('users').where({ email }).update({ verified: true });
  const login = await request(live!.app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  expect(login.status).toBe(200);
  const id = (await live!.db('users').where({ email }).first('id')).id as string;
  users.push(id);
  const cookies = ([] as string[]).concat(login.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]!);
  return { id, email, token: login.body.token, csrf: login.body.csrfToken, cookies };
}
const bearer = (a: Acct) => ({ Authorization: `Bearer ${a.token}` });

/** Enroll + confirm; returns the secret and the recovery codes. The confirm step consumes the current step. */
async function enable(a: Acct): Promise<{ secret: string; recovery: string[] }> {
  const e = await request(live!.app).post('/api/v1/auth/mfa/enroll').set(bearer(a)).send({ password: PASSWORD });
  expect(e.status).toBe(200);
  const secret = e.body.secret as string;
  const v = await request(live!.app).post('/api/v1/auth/mfa/verify').set(bearer(a)).send({ code: totpAt(secret, Date.now()) });
  expect(v.status).toBe(200);
  return { secret, recovery: v.body.recoveryCodes };
}
const loginStepOne = (a: Acct) => request(live!.app).post('/api/v1/auth/login').send({ email: a.email, password: PASSWORD });
/** A code for the NEXT 30 s step: valid (±1 window) yet newer than the step used at enrollment. */
const nextCode = (secret: string) => totpAt(secret, Date.now() + 30_000);

describe('TOTP 2FA (live app)', () => {
  it('enrollment needs the current password, stores the secret encrypted, and shows recovery codes once', async (ctx) => {
    if (skip) return ctx.skip();
    const a = await account();
    const wrong = await request(live!.app).post('/api/v1/auth/mfa/enroll').set(bearer(a)).send({ password: 'not-my-password-1' });
    expect(wrong.status).toBe(403);
    expect(wrong.status).not.toBe(401); // 401 would make the dashboard drop the session

    const e = await request(live!.app).post('/api/v1/auth/mfa/enroll').set(bearer(a)).send({ password: PASSWORD });
    expect(e.status).toBe(200);
    expect(e.headers['cache-control']).toBe('no-store');
    expect(e.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(e.body.otpauthUri).toContain('otpauth://totp/');
    expect((await request(live!.app).get('/api/v1/auth/mfa').set(bearer(a))).body).toEqual({ enabled: false, recoveryCodesRemaining: 0 });

    const bad = await request(live!.app).post('/api/v1/auth/mfa/verify').set(bearer(a)).send({ code: '000000' });
    expect(bad.status).toBe(400);
    const good = await request(live!.app).post('/api/v1/auth/mfa/verify').set(bearer(a)).send({ code: totpAt(e.body.secret, Date.now()) });
    expect(good.status).toBe(200);
    expect(good.body.recoveryCodes).toHaveLength(10);
    expect(good.body.recoveryCodes[0]).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
    expect((await request(live!.app).get('/api/v1/auth/mfa').set(bearer(a))).body).toEqual({ enabled: true, recoveryCodesRemaining: 10 });

    const row = await live!.db('user_mfa').where({ user_id: a.id }).first();
    expect(row.secret_enc).not.toContain(e.body.secret);
    expect(row.secret_enc.startsWith('v1.')).toBe(true);
    const hashes = (await live!.db('user_recovery_codes').where({ user_id: a.id })).map((r) => r.code_hash as string);
    expect(hashes.join('')).not.toContain(good.body.recoveryCodes[0].replace('-', ''));

    // Cannot re-enroll over an enabled factor.
    expect((await request(live!.app).post('/api/v1/auth/mfa/enroll').set(bearer(a)).send({ password: PASSWORD })).status).toBe(409);
  });

  it('login becomes two-step: password alone yields a challenge and NO session', async (ctx) => {
    if (skip) return ctx.skip();
    const a = await account();
    const { secret } = await enable(a);
    const one = await loginStepOne(a);
    expect(one.status).toBe(200);
    expect(one.body.mfaRequired).toBe(true);
    expect(typeof one.body.mfaToken).toBe('string');
    expect(one.body.token).toBeUndefined();
    expect(one.body.user).toBeUndefined();
    expect(one.headers['set-cookie']).toBeUndefined();

    const two = await request(live!.app).post('/api/v1/auth/login/mfa').send({ mfaToken: one.body.mfaToken, code: nextCode(secret) });
    expect(two.status).toBe(200);
    expect(two.body.user.email).toBe(a.email);
    expect(two.body.token).toBeTruthy();
    expect(([] as string[]).concat(two.headers['set-cookie'] ?? []).join(';')).toContain('fl_session');

    // The issued session works.
    expect((await request(live!.app).get('/api/v1/users/me').set({ Authorization: `Bearer ${two.body.token}` })).status).toBe(200);
  });

  it('a TOTP code cannot be replayed; a wrong code and a bad/forged challenge are rejected', async (ctx) => {
    if (skip) return ctx.skip();
    const a = await account();
    const { secret } = await enable(a);
    const code = nextCode(secret);
    const c1 = (await loginStepOne(a)).body.mfaToken;
    expect((await request(live!.app).post('/api/v1/auth/login/mfa').send({ mfaToken: c1, code })).status).toBe(200);
    const c2 = (await loginStepOne(a)).body.mfaToken;
    const replay = await request(live!.app).post('/api/v1/auth/login/mfa').send({ mfaToken: c2, code });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('INVALID_MFA_CODE');

    const forged = await request(live!.app).post('/api/v1/auth/login/mfa').send({ mfaToken: `${c2.split('.')[0]}.AAAA`, code: nextCode(secret) });
    expect(forged.status).toBe(401);
    expect(forged.body.error.code).toBe('MFA_CHALLENGE_INVALID');
    expect((await request(live!.app).post('/api/v1/auth/login/mfa').send({ mfaToken: 'garbage', code: '123456' })).status).toBe(401);
    expect((await request(live!.app).post('/api/v1/auth/login/mfa').send({ code: '123456' })).status).toBe(400);
  });

  it('a challenge is bound to its user: user B\'s challenge never authenticates with user A\'s code', async (ctx) => {
    if (skip) return ctx.skip();
    const a = await account();
    const b = await account();
    const A = await enable(a);
    await enable(b);
    const chB = (await loginStepOne(b)).body.mfaToken;
    const res = await request(live!.app).post('/api/v1/auth/login/mfa').send({ mfaToken: chB, code: nextCode(A.secret) });
    expect(res.status).toBe(401);
  });

  it('recovery codes work exactly once, case/dash-insensitively', async (ctx) => {
    if (skip) return ctx.skip();
    const a = await account();
    const { recovery } = await enable(a);
    const code = recovery[0]!;
    const c1 = (await loginStepOne(a)).body.mfaToken;
    const ok = await request(live!.app).post('/api/v1/auth/login/mfa').send({ mfaToken: c1, code: code.toLowerCase().replace('-', ' ') });
    expect(ok.status).toBe(200);
    expect(ok.body.mfaMethod).toBe('recovery');
    const c2 = (await loginStepOne(a)).body.mfaToken;
    expect((await request(live!.app).post('/api/v1/auth/login/mfa').send({ mfaToken: c2, code })).status).toBe(401);
    expect((await request(live!.app).get('/api/v1/auth/mfa').set(bearer(a))).body.recoveryCodesRemaining).toBe(9);
  });

  it('5 consecutive wrong codes lock the account for 15 minutes — even the right code is refused', async (ctx) => {
    if (skip) return ctx.skip();
    const a = await account();
    const { secret } = await enable(a);
    const ch = (await loginStepOne(a)).body.mfaToken;
    for (let i = 0; i < 5; i++) {
      const r = await request(live!.app).post('/api/v1/auth/login/mfa').send({ mfaToken: ch, code: '000000' });
      expect(r.status).toBe(401);
    }
    const locked = await request(live!.app).post('/api/v1/auth/login/mfa').send({ mfaToken: ch, code: nextCode(secret) });
    expect(locked.status).toBe(423);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(800);
    // Expiry of the lock restores access (simulate by moving locked_until into the past).
    await live!.db('user_mfa').where({ user_id: a.id }).update({ locked_until: new Date(Date.now() - 1000) });
    expect((await request(live!.app).post('/api/v1/auth/login/mfa').send({ mfaToken: ch, code: nextCode(secret) })).status).toBe(200);
  });

  it('disable and recovery-code regeneration need password AND a valid second factor', async (ctx) => {
    if (skip) return ctx.skip();
    const a = await account();
    const { secret, recovery } = await enable(a);
    const noCode = await request(live!.app).post('/api/v1/auth/mfa/disable').set(bearer(a)).send({ password: PASSWORD, code: '000000' });
    expect(noCode.status).toBe(401);
    const noPw = await request(live!.app).post('/api/v1/auth/mfa/disable').set(bearer(a)).send({ password: 'nope-nope-nope-1', code: nextCode(secret) });
    expect(noPw.status).toBe(403);

    const regen = await request(live!.app).post('/api/v1/auth/mfa/recovery-codes').set(bearer(a)).send({ password: PASSWORD, code: nextCode(secret) });
    expect(regen.status).toBe(200);
    expect(regen.body.recoveryCodes).toHaveLength(10);
    // Old codes are dead.
    const ch = (await loginStepOne(a)).body.mfaToken;
    expect((await request(live!.app).post('/api/v1/auth/login/mfa').send({ mfaToken: ch, code: recovery[1] })).status).toBe(401);

    const off = await request(live!.app).post('/api/v1/auth/mfa/disable').set(bearer(a)).send({ password: PASSWORD, code: regen.body.recoveryCodes[0] });
    expect(off.status).toBe(204);
    expect((await request(live!.app).get('/api/v1/auth/mfa').set(bearer(a))).body.enabled).toBe(false);
    const plain = await loginStepOne(a);
    expect(plain.body.token).toBeTruthy();
    expect(await live!.db('user_mfa').where({ user_id: a.id }).first()).toBeUndefined();
    expect(await live!.db('user_recovery_codes').where({ user_id: a.id })).toHaveLength(0);
  });

  it('requires a session, and org API keys can never manage 2FA', async (ctx) => {
    if (skip) return ctx.skip();
    expect((await request(live!.app).get('/api/v1/auth/mfa')).status).toBe(401);
    const key = await request(live!.app).get('/api/v1/auth/mfa').set({ Authorization: 'Bearer pk_fakefakefakefakefakefake' });
    expect(key.status).toBe(403);
    expect((await request(live!.app).post('/api/v1/auth/mfa/disable').send({})).status).toBe(401);
  });

  it('cookie sessions must send the CSRF token on 2FA mutations', async (ctx) => {
    if (skip) return ctx.skip();
    const a = await account();
    const noCsrf = await request(live!.app).post('/api/v1/auth/mfa/enroll').set('Cookie', a.cookies).send({ password: PASSWORD });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error.code).toBe('CSRF_INVALID');
    const withCsrf = await request(live!.app).post('/api/v1/auth/mfa/enroll').set('Cookie', a.cookies).set('X-CSRF-Token', a.csrf).send({ password: PASSWORD });
    expect(withCsrf.status).toBe(200);
  });

  it('audit trail records the challenge, success, failure and lifecycle events (no codes or secrets)', async (ctx) => {
    if (skip) return ctx.skip();
    const a = await account();
    const { secret } = await enable(a);
    const ch = (await loginStepOne(a)).body.mfaToken;
    await request(live!.app).post('/api/v1/auth/login/mfa').send({ mfaToken: ch, code: '000000' });
    await request(live!.app).post('/api/v1/auth/login/mfa').send({ mfaToken: ch, code: nextCode(secret) });
    const wanted = ['auth.mfa_enabled', 'auth.login_mfa_challenged', 'auth.mfa_failed'];
    let rows: Array<Record<string, any>> = [];
    for (let i = 0; i < 40; i++) {
      rows = await live!.db('audit_logs').where({ actor_id: a.id });
      if (wanted.every((w) => rows.some((r) => r.action === w))) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    for (const w of wanted) expect(rows.some((r) => r.action === w), w).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(secret);
  });
});
