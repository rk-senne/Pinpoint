// Bcrypt-backed PasswordHasher adapter (Phase 1.5 / task 4.8.5).
//
// Per the hexagonal architecture rules, this file is the ONLY place in
// the codebase that imports `bcrypt`. Domain code depends on the
// `PasswordHasher` port; the composition root wires this adapter in.
//
// Salt rounds default to 10. The composition root is free to override
// per environment.

import bcrypt from 'bcrypt';

import type { PasswordHasher } from '../../../domain/auth/ports/PasswordHasher.js';

export class BcryptPasswordHasher implements PasswordHasher {
  private readonly saltRounds: number;

  constructor(saltRounds: number = 10) {
    this.saltRounds = saltRounds;
  }

  hash(plain: string): Promise<string> {
    return bcrypt.hash(plain, this.saltRounds);
  }

  verify(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
  }
}
