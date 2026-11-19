// PP-15 regression tests: cookie naming/attributes and session-bound CSRF.
import { describe, it, expect } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { request } from '../__tests__/supertestClient.js';
import { JwtTokenIssuer } from '../adapters/outbound/jwt/JwtTokenIssuer.js';
import { createCsrfMiddleware } from './csrf.js';
import {
  buildClearCookies,
  buildCsrfCookie,
  buildSessionCookie,
  createCsrfBinder,
  readCsrfCookie,
  readSessionCookie,
} from './sessionCookies.js';

const claims = { userId: 'u1', email: 'a@b.test', orgId: 'o1', role: 'owner', tokenVersion: 0 };

describe('cookie names and attributes', () => {
  it('uses __Host- names with Secure + Path=/ + Max-Age and no Domain when Secure', () => {
    const s = buildSessionCookie('jwt', false);
    const c = buildCsrfCookie('tok', false);
    expect(s.startsWith('__Host-fl_session=jwt;')).toBe(true);
    expect(c.startsWith('__Host-fl_csrf=tok;')).toBe(true);
    for (const cookie of [s, c]) {
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('Path=/');
      expect(cookie).toMatch(/Max-Age=\d+/);
      expect(cookie).not.toMatch(/Domain=/i);
    }
    expect(s).toContain('HttpOnly');
  });

  it('keeps the legacy un-prefixed names (no Secure, no prefix) when COOKIE_INSECURE', () => {
    const s = buildSessionCookie('jwt', true);
    const c = buildCsrfCookie('tok', true);
    expect(s.startsWith('fl_session=jwt;')).toBe(true);
    expect(c.startsWith('fl_csrf=tok;')).toBe(true);
    expect(s).not.toContain('Secure');
    expect(c).not.toContain('Secure');
    expect(s).toMatch(/Max-Age=86400/);
  });

  it('clears both cookie generations on logout when Secure', () => {
    const cleared = buildClearCookies(false).join('\n');
    expect(cleared).toContain('__Host-fl_session=;');
    expect(cleared).toContain('fl_session=;');
    expect(cleared).toContain('__Host-fl_csrf=;');
    expect(buildClearCookies(true)).toHaveLength(2);
  });

  it('readers accept both names, preferring __Host-', () => {
    expect(readSessionCookie({ fl_session: 'a' })).toBe('a');
    expect(readSessionCookie({ '__Host-fl_session': 'h', fl_session: 'a' })).toBe('h');
    expect(readCsrfCookie({ '__Host-fl_csrf': 'h' })).toBe('h');
    expect(readCsrfCookie({})).toBeNull();
  });
});

describe('session-bound CSRF', () => {
  const issuer = new JwtTokenIssuer({ secret: 's'.repeat(40) });
  const binder = createCsrfBinder({ secret: 'j'.repeat(40), tokenIssuer: issuer });

  function app() {
    const a = express();
    a.use(cookieParser());
    a.use(createCsrfMiddleware({ tokenIssuer: issuer, binder }));
    a.post('/x', (_req, res) => res.json({ ok: true }));
    return a;
  }

  it('accepts a token minted for this session', async () => {
    const jwt = issuer.sign(claims);
    const csrf = binder.mintForToken(jwt);
    const res = await request(app())
      .post('/x')
      .set('Cookie', [`fl_session=${jwt}`, `fl_csrf=${csrf}`])
      .set('X-CSRF-Token', csrf)
      .send({});
    expect(res.status).toBe(200);
  });

  it('rejects an attacker-chosen (tossed) cookie+header pair even though they match', async () => {
    const jwt = issuer.sign(claims);
    const res = await request(app())
      .post('/x')
      .set('Cookie', [`fl_session=${jwt}`, 'fl_csrf=attacker'])
      .set('X-CSRF-Token', 'attacker')
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_INVALID');
  });

  it('rejects a valid token minted for a different session', async () => {
    const mine = issuer.sign(claims);
    const theirs = issuer.sign({ ...claims, userId: 'u2' });
    const csrf = binder.mintForToken(theirs);
    const res = await request(app())
      .post('/x')
      .set('Cookie', [`fl_session=${mine}`, `fl_csrf=${csrf}`])
      .set('X-CSRF-Token', csrf)
      .send({});
    expect(res.status).toBe(403);
  });

  it('rejects a token with a tampered MAC and one signed under another secret', async () => {
    const jwt = issuer.sign(claims);
    const good = binder.mintForToken(jwt);
    const tampered = good.slice(0, -1) + (good.endsWith('0') ? '1' : '0');
    const other = createCsrfBinder({ secret: 'z'.repeat(40), tokenIssuer: issuer }).mintForToken(jwt);
    for (const bad of [tampered, other]) {
      const res = await request(app())
        .post('/x')
        .set('Cookie', [`fl_session=${jwt}`, `fl_csrf=${bad}`])
        .set('X-CSRF-Token', bad)
        .send({});
      expect(res.status).toBe(403);
    }
  });

  it('stays valid across refresh/org-switch (same sessionStart) but not after re-login', () => {
    const first = issuer.sign({ ...claims, sessionStart: 1000 });
    const csrf = binder.mintForToken(first);
    const switched = issuer.sign({ ...claims, orgId: 'o2', sessionStart: 1000 });
    const relogin = issuer.sign({ ...claims, sessionStart: 2000 });
    expect(binder.isBoundTo(csrf, switched)).toBe(true);
    expect(binder.isBoundTo(csrf, relogin)).toBe(false);
  });

  it('works for an expired session JWT so /auth/refresh stays CSRF-protected but usable', () => {
    const expiring = new JwtTokenIssuer({ secret: 's'.repeat(40), accessTtl: -10 });
    const expired = expiring.sign(claims);
    const csrf = binder.mintForToken(expired);
    expect(binder.isBoundTo(csrf, expired)).toBe(true);
  });
});
