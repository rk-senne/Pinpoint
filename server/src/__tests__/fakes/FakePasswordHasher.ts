// FakePasswordHasher — deterministic PasswordHasher fake (Phase 1.5 /
// task 4.11.1).
//
// `hash(plain)` returns the literal string `'hashed:' + plain`; `verify`
// re-runs the same transformation and compares strings. Behavior is
// fully deterministic so tests can construct expected hashes inline.

import type { PasswordHasher } from '../../domain/auth/ports/PasswordHasher.js';

const PREFIX = 'hashed:';

export class FakePasswordHasher implements PasswordHasher {
  async hash(plain: string): Promise<string> {
    return `${PREFIX}${plain}`;
  }

  async verify(plain: string, hash: string): Promise<boolean> {
    return hash === `${PREFIX}${plain}`;
  }
}
