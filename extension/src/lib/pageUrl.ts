/**
 * pageUrl sanitiser (F5). The widget runs on arbitrary customer pages whose
 * URLs routinely carry secrets (`?token=…`, OAuth `?code=…`, signed-URL
 * `?sig=…`, `#access_token=…`). Before a URL leaves the page we:
 *   - drop the fragment entirely,
 *   - drop any `user:pass@` credentials,
 *   - keep every query key but replace the VALUE of sensitive keys with
 *     {@link REDACTED_VALUE}.
 * Duplicated in widget/src/pageUrl.ts (the widget bundle and the extension
 * cannot share runtime code — keep the two copies in lockstep).
 */

export const REDACTED_VALUE = 'REDACTED';

const EXACT_SENSITIVE_KEYS = new Set([
  'code',
  'key',
  'sig',
  'signature',
  'state',
  'password',
  'secret',
  'session',
  'auth',
]);

const SENSITIVE_KEY_PATTERN =
  /(token|secret|passw|passwd|pwd|session|auth|signature|api[_-]?key|credential|jwt)/i;

export function isSensitiveQueryKey(key: string): boolean {
  let k = key;
  try {
    k = decodeURIComponent(key.replace(/\+/g, ' '));
  } catch {
    /* keep raw key */
  }
  const lower = k.toLowerCase();
  return EXACT_SENSITIVE_KEYS.has(lower) || SENSITIVE_KEY_PATTERN.test(lower);
}

export function sanitizePageUrl(href: string): string {
  try {
    const u = new URL(href);
    u.hash = '';
    u.username = '';
    u.password = '';
    if (u.search.length > 1) {
      const parts = u.search
        .slice(1)
        .split('&')
        .map((pair) => {
          if (pair === '') return pair;
          const eq = pair.indexOf('=');
          const key = eq === -1 ? pair : pair.slice(0, eq);
          if (!isSensitiveQueryKey(key)) return pair;
          return `${key}=${REDACTED_VALUE}`;
        });
      u.search = `?${parts.join('&')}`;
    }
    return u.toString();
  } catch {
    // Not parseable: strip fragment and query defensively.
    return href.split('#')[0]!.split('?')[0]!;
  }
}
