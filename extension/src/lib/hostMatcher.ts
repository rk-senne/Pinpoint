/**
 * Pattern matching for the Extension allow-list / block-list of host patterns.
 *
 * Validates Requirement 46.4: pattern matching supports exact hosts and
 * `*.example.com` wildcards.
 *
 * Rules (kept intentionally small — no regex, no mid-string wildcards):
 *   - Patterns and hosts are trimmed and lowercased before comparison.
 *   - An empty pattern never matches.
 *   - An exact pattern matches only when it equals the host.
 *   - A pattern beginning with `*.` matches:
 *       a) the apex domain (host equals the suffix exactly), AND
 *       b) any subdomain of the suffix (host ends with `.<suffix>`).
 *     So `*.example.com` matches `example.com`, `app.example.com`, and
 *     `a.b.example.com`, but does NOT match `notexample.com` or `example.org`.
 */

const WILDCARD_PREFIX = '*.';

/**
 * Returns true when `host` matches `pattern` per the rules above.
 */
export function hostMatchesPattern(host: string, pattern: string): boolean {
  const normalizedHost = host.trim().toLowerCase();
  const normalizedPattern = pattern.trim().toLowerCase();

  if (normalizedPattern.length === 0) {
    return false;
  }

  if (normalizedPattern.startsWith(WILDCARD_PREFIX)) {
    const suffix = normalizedPattern.slice(WILDCARD_PREFIX.length);
    if (suffix.length === 0) {
      // `*.` on its own is not a meaningful pattern — refuse to match.
      return false;
    }
    if (normalizedHost === suffix) {
      return true;
    }
    return normalizedHost.endsWith(`.${suffix}`);
  }

  return normalizedHost === normalizedPattern;
}

/**
 * Returns true when `host` matches at least one pattern in `patterns`.
 */
export function hostMatchesAny(host: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (hostMatchesPattern(host, pattern)) {
      return true;
    }
  }
  return false;
}
