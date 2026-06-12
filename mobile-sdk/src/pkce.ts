// PKCE helper utilities — works in browser (Web Crypto) and Node.js (crypto).

/** Generate a random code_verifier (43-128 unreserved chars per RFC 7636). */
export function generateCodeVerifier(length = 64): string {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = getRandomBytes(length);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += charset[bytes[i] % charset.length];
  }
  return result;
}

/** Generate S256 code_challenge from verifier. */
export async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoded = new TextEncoder().encode(verifier);

  // Use Web Crypto API (browser + Node 18+)
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    const hash = await globalThis.crypto.subtle.digest('SHA-256', encoded);
    return base64url(new Uint8Array(hash));
  }

  // Fallback: Node.js crypto
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256').update(encoded).digest();
  return base64url(new Uint8Array(hash));
}

function getRandomBytes(length: number): Uint8Array {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
    const arr = new Uint8Array(length);
    globalThis.crypto.getRandomValues(arr);
    return arr;
  }
  // Node.js fallback
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { randomBytes } = require('node:crypto') as typeof import('node:crypto');
  return new Uint8Array(randomBytes(length));
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
