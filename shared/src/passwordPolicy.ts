/**
 * Password policy: minimum-length floor + Common_Passwords_Blocklist (Req 1.10, 1.11).
 *
 * The blocklist is the SecLists `10k-most-common.txt` corpus, normalised to lowercase
 * and de-duplicated, bundled as `shared/data/common-passwords.json`. We load it lazily
 * into a `Set<string>` so each lookup is O(1).
 *
 * `validatePassword` is intentionally pure and synchronous so register / change-password
 * handlers can call it inline before any hashing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

const LEET: Record<string, string> = { '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's' };

export type PasswordValidation =
  | { ok: true }
  | { ok: false; error: string };

let cachedSet: Set<string> | null = null;

function loadBlocklistSet(): Set<string> {
  if (cachedSet) return cachedSet;

  // Resolve `shared/data/common-passwords.json` whether running from `src/` (vitest)
  // or `dist/` (built artifact) — both are siblings of `data/`.
  // The shared package compiles to CommonJS, so `__dirname` is available at runtime.
  const dataPath = join(__dirname, '..', 'data', 'common-passwords.json');
  const raw = readFileSync(dataPath, 'utf8');
  const arr = JSON.parse(raw) as string[];
  cachedSet = new Set(arr);
  return cachedSet;
}

/**
 * Returns `{ ok: true }` when `password` satisfies the policy. On failure returns
 * `{ ok: false, error }` with a human-readable reason. Callers MUST translate
 * the failure into a 400 response with `{ error: { code: 'WEAK_PASSWORD', message } }`.
 *
 * Rules:
 *   1. Length >= PASSWORD_MIN_LENGTH (10).
 *   2. Lowercased password is NOT in the Common_Passwords_Blocklist.
 *
 * The function does not throw on the empty string or non-ASCII input; it just
 * fails the policy as appropriate.
 */
export function validatePassword(password: string): PasswordValidation {
  if (typeof password !== 'string') {
    return { ok: false, error: 'Password must be a string.' };
  }

  if (password.length < PASSWORD_MIN_LENGTH) {
    return {
      ok: false,
      error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`,
    };
  }

  if (password.length > PASSWORD_MAX_LENGTH) {
    return { ok: false, error: `Password must be at most ${PASSWORD_MAX_LENGTH} characters.` };
  }

  // PP-12: "aaaaaaaaaaaa" / "abababababab" satisfy the length floor but carry no entropy.
  if (new Set(password).size < 5) {
    return { ok: false, error: 'Password is too predictable. Use a mix of different characters.' };
  }

  const blocklist = loadBlocklistSet();
  const lower = password.toLowerCase();
  // "Password1234" / "Qwerty123456!" are blocklist words with a decorative suffix:
  // compare the stem (trailing digits / symbols removed), also after undoing
  // common letter substitutions (p@ssw0rd → password).
  const stem = lower.replace(/[^a-z]+$/, '');
  const rawStem = lower.replace(/[0-9!#%^&*._-]+$/, '');
  const deLeet = (s: string): string => s.replace(/[01345@$7]/g, (c) => LEET[c] ?? c);
  if (
    blocklist.has(lower) ||
    (stem.length >= 4 && blocklist.has(stem)) ||
    (rawStem.length >= 4 && blocklist.has(deLeet(rawStem)))
  ) {
    return {
      ok: false,
      error: 'Password is too common. Choose a less predictable password.',
    };
  }

  return { ok: true };
}

/**
 * Test-only hook: allows unit tests to inspect the loaded blocklist size without
 * forcing them to read the JSON file themselves.
 */
export function getCommonPasswordCount(): number {
  return loadBlocklistSet().size;
}
