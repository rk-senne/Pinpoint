import { describe, expect, it } from 'vitest';
import { AUDIT_RULES, matchAuditRule } from './auditTrail.js';

describe('matchAuditRule', () => {
  const cases: Array<[string, string, boolean]> = [
    ['POST', '/auth/login', true],
    ['POST', '/auth/login/', true],
    ['GET', '/auth/login', false],
    ['POST', '/auth/logout', true],
    ['POST', '/auth/login/mfa', true],
    ['POST', '/auth/mfa/verify', true],
    ['POST', '/auth/mfa/disable', true],
    ['POST', '/auth/mfa/recovery-codes', true],
    ['POST', '/auth/reset-password', true],
    ['POST', '/auth/reset-password/tok123', true],
    ['POST', '/auth/verify-email/tok123', true],
    ['PUT', '/users/me', true],
    ['POST', '/org/revoke-sessions', true],
    ['POST', '/org/switch', true],
    ['POST', '/projects/abc/export', true],
    ['POST', '/projects/abc/share', true],
    ['PUT', '/teams/t1/members/u1', true],
    ['DELETE', '/teams/t1/members/u1', true],
    ['GET', '/projects', false],
    ['POST', '/projects/abc/annotations', false],
    ['DELETE', '/auth/login', false],
  ];
  it.each(cases)('%s %s → %s', (method, path, expected) => {
    expect(matchAuditRule(method, path) !== null).toBe(expected);
  });

  it('captures path parameters', () => {
    expect(matchAuditRule('PUT', '/teams/t1/members/u9')!.match.slice(1, 3)).toEqual(['t1', 'u9']);
  });

  it('has no two rules with the same method and pattern (would double-write rows)', () => {
    const keys = AUDIT_RULES.map((r) => `${r.method} ${r.re.source}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
