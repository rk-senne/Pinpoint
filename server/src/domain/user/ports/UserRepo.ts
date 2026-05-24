// UserRepo outbound port (Phase 1.5 / task 4.6.2).

import type { NewUser, User, UserPatch } from '../User.js';

/**
 * Read-side projection that includes the password hash. Auth use cases
 * (`login`, `verifyEmail`) need the hash to verify credentials; everywhere
 * else the plain `User` type (no hash) is preferred so the secret cannot
 * accidentally leak through a response payload.
 */
export interface UserWithSecret extends User {
  passwordHash: string;
  verified: boolean;
}

export interface UserRepo {
  insert(input: NewUser): Promise<User>;
  findById(id: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  /** Same lookup as `findByEmail` but also returns the password hash. */
  findByEmailWithSecret(email: string): Promise<UserWithSecret | null>;
  findByIdWithSecret(id: string): Promise<UserWithSecret | null>;
  update(id: string, patch: UserPatch): Promise<User>;
  /** Mark a user as verified after a successful email-verification token redemption. */
  markVerified(id: string): Promise<void>;
}
