// PasswordHasher outbound port (Phase 1.5 / task 4.6.2).
//
// The bcrypt adapter is the only file in the codebase that imports
// `bcrypt`; domain code depends on this interface.

export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(plain: string, hash: string): Promise<boolean>;
}
