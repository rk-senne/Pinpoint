// SSRF egress guard for all server-initiated outbound HTTP (Mission A5a).
//
// Pinpoint fetches arbitrary customer-supplied URLs: outbound webhooks and
// OAuth token endpoints. Without a guard, a webhook URL of
// `http://169.254.169.254/latest/meta-data/iam/security-credentials/` turns
// our egress into a credential-exfiltration primitive against the cloud
// instance metadata service (IMDS). A naive "reject private IPs by parsing the
// URL host" check is defeated by DNS rebinding: an attacker points
// `evil.example.com` at a public IP for the validation lookup, then re-answers
// with 169.254.169.254 for the actual connection.
//
// This module closes both holes:
//   1. `assertPublicUrl` resolves the hostname via dns.lookup({ all: true })
//      and rejects the request if ANY returned address is private / loopback /
//      link-local / CGNAT / ULA / IPv4-mapped / unspecified / multicast, or is
//      a known metadata endpoint (169.254.169.254, metadata.google.internal).
//      It also enforces https-only unless an explicit dev flag opts into http.
//   2. `safeFetch` performs the fetch with undici pinned to the exact IP that
//      was validated (custom `lookup` on the Agent), so the socket connects to
//      the address we checked — DNS rebinding between check and connect is
//      impossible.

import dns from 'node:dns';
import net from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

const METADATA_HOSTNAMES = new Set<string>([
  'metadata.google.internal',
  'metadata',
]);

const METADATA_IPS = new Set<string>([
  '169.254.169.254', // AWS/GCP/Azure IMDS
  'fd00:ec2::254', // AWS IMDSv6
]);

export interface EgressGuardOptions {
  /**
   * When true, plain `http://` URLs are permitted (local dev only). Defaults
   * to false — production is https-only. Wire from a dev config flag, never
   * enable in production.
   */
  allowHttp?: boolean;
  /** Overridable resolver for testing. Defaults to dns.lookup (all addrs). */
  lookup?: LookupAllFn;
  /**
   * TEST-ONLY. Lets addresses returned by an injected `lookup` for a
   * *hostname* be private/loopback so an integration test can point a fake
   * public hostname at a local HTTP server. IP-literal URLs (and therefore
   * `http://127.0.0.1/` / `http://169.254.169.254/` redirect targets) are
   * ALWAYS checked. Never wired from config, and ignored (throws) unless
   * `NODE_ENV === 'test'` so a stray value can't weaken a real deployment.
   * @internal
   */
  allowPrivateForTests?: boolean;
}

/** Maximum redirects `safeFetch` follows itself (each hop re-validated). */
export const SAFE_FETCH_MAX_REDIRECTS = 3;

export type LookupAllFn = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const defaultLookupAll: LookupAllFn = (hostname) =>
  new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses as Array<{ address: string; family: number }>);
    });
  });

export class EgressBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EgressBlockedError';
  }
}

/** Parse an IPv4 dotted-quad into its four octets, or null if not IPv4. */
function ipv4Octets(ip: string): [number, number, number, number] | null {
  if (net.isIPv4(ip) !== true) return null;
  const parts = ip.split('.').map((p) => Number(p));
  return parts as [number, number, number, number];
}

/**
 * Expand any valid IPv6 literal (compressed, uppercase, embedded dotted-quad
 * tail) to its 16 raw bytes. Classifying on bytes instead of string prefixes
 * means no alternate textual spelling (`::ffff:7f00:1`,
 * `0:0:0:0:0:ffff:127.0.0.1`, `::FFFF:A9FE:A9FE`, …) can dodge a rule.
 */
function ipv6Bytes(ip: string): Uint8Array | null {
  if (net.isIPv6(ip) !== true) return null;
  let s = ip;
  // Embedded dotted IPv4 tail → two hex groups.
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (net.isIPv4(tail)) {
    const [a, b, c, d] = tail.split('.').map(Number) as [number, number, number, number];
    s = `${s.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = s.split('::') as [string, string | undefined];
  const headGroups = head ? head.split(':') : [];
  const restGroups = rest !== undefined && rest !== '' ? rest.split(':') : [];
  const fill = rest !== undefined ? 8 - headGroups.length - restGroups.length : 0;
  const groups = [...headGroups, ...Array(fill).fill('0'), ...restGroups];
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  groups.forEach((g, i) => {
    const v = parseInt(g, 16);
    bytes[i * 2] = (v >> 8) & 0xff;
    bytes[i * 2 + 1] = v & 0xff;
  });
  return bytes;
}

/** True when the first `n` bytes of `bytes` are all zero. */
function zeroPrefix(bytes: Uint8Array, n: number): boolean {
  for (let i = 0; i < n; i++) if (bytes[i] !== 0) return false;
  return true;
}

/**
 * True when an IP literal must never be the target of an outbound fetch.
 * Covers loopback, RFC1918 private, link-local (incl. CGNAT 100.64/10),
 * unspecified, multicast/reserved, IPv6 ULA (fc00::/7), IPv6 loopback/
 * unspecified/link-local/multicast, every IPv6 form that embeds an IPv4
 * address (mapped ::ffff:0:0/96, compatible ::/96, NAT64 64:ff9b::/96,
 * 6to4 2002::/16 — the embedded IPv4 is extracted and re-checked), and
 * known metadata IPs.
 */
export function isBlockedAddress(ipRaw: string): boolean {
  let ip = ipRaw.trim().toLowerCase();

  // Strip brackets and zone id (e.g. [fe80::1%eth0]).
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  const zoneIdx = ip.indexOf('%');
  if (zoneIdx !== -1) ip = ip.slice(0, zoneIdx);

  if (METADATA_IPS.has(ip)) return true;

  const v6 = ipv6Bytes(ip);
  if (v6) {
    const embedded = (offset: number) =>
      `${v6[offset]}.${v6[offset + 1]}.${v6[offset + 2]}.${v6[offset + 3]}`;
    // ::ffff:0:0/96 IPv4-mapped → check the embedded IPv4.
    if (zeroPrefix(v6, 10) && v6[10] === 0xff && v6[11] === 0xff) {
      return isBlockedAddress(embedded(12));
    }
    // ::/96 IPv4-compatible (deprecated) — includes :: and ::1 → block all.
    if (zeroPrefix(v6, 12)) return true;
    // 64:ff9b::/96 NAT64 well-known prefix → check the embedded IPv4.
    if (v6[0] === 0x00 && v6[1] === 0x64 && v6[2] === 0xff && v6[3] === 0x9b && zeroPrefix(v6.subarray(4), 8)) {
      return isBlockedAddress(embedded(12));
    }
    // 2002::/16 6to4 → embedded IPv4 is bytes 2..5.
    if (v6[0] === 0x20 && v6[1] === 0x02) return isBlockedAddress(embedded(2));
    if ((v6[0]! & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
    if (v6[0] === 0xfe && (v6[1]! & 0xc0) === 0x80) return true; // fe80::/10 link-local
    if (v6[0] === 0xfe && (v6[1]! & 0xc0) === 0xc0) return true; // fec0::/10 site-local (deprecated)
    if (v6[0] === 0xff) return true; // ff00::/8 multicast
    return false;
  }

  const octets = ipv4Octets(ip);
  if (octets) {
    const [a, b] = octets;
    if (a === 0) return true; // 0.0.0.0/8 "this network" / unspecified
    if (a === 10) return true; // 10.0.0.0/8 private
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (+IMDS)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a === 192 && b === 0) return true; // 192.0.0.0/24 + 192.0.2.0/24 reserved/test
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
    if (a >= 224) return true; // 224.0.0.0/4 multicast + 240/4 reserved
    return false;
  }

  // Not a recognisable IP literal: fail closed.
  return true;
}

export interface ValidatedTarget {
  url: URL;
  /** The single IP the connection must be pinned to. */
  pinnedIp: string;
  family: number;
}

/**
 * Validate that `rawUrl` is safe to fetch: http(s) scheme (https unless
 * `allowHttp`), resolvable hostname, and EVERY resolved address public.
 * Returns the parsed URL plus the first validated IP for connection pinning.
 * Throws `EgressBlockedError` on any violation.
 */
export async function assertPublicUrl(
  rawUrl: string,
  options: EgressGuardOptions = {},
): Promise<ValidatedTarget> {
  const allowHttp = options.allowHttp ?? false;
  const lookupAll = options.lookup ?? defaultLookupAll;
  if (options.allowPrivateForTests && process.env.NODE_ENV !== 'test') {
    throw new EgressBlockedError('allowPrivateForTests is only honoured when NODE_ENV=test');
  }
  const allowPrivate = options.allowPrivateForTests === true;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new EgressBlockedError('Invalid URL');
  }

  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    throw new EgressBlockedError(
      allowHttp
        ? `Blocked scheme: ${url.protocol} (only http/https allowed)`
        : `Blocked scheme: ${url.protocol} (https required)`,
    );
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (METADATA_HOSTNAMES.has(hostname)) {
    throw new EgressBlockedError(`Blocked metadata hostname: ${hostname}`);
  }

  // If the host is an IP literal, validate it directly (no DNS).
  if (net.isIP(hostname) !== 0) {
    if (isBlockedAddress(hostname)) {
      throw new EgressBlockedError(`Blocked IP address: ${hostname}`);
    }
    return { url, pinnedIp: hostname, family: net.isIPv6(hostname) ? 6 : 4 };
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookupAll(hostname);
  } catch {
    throw new EgressBlockedError(`DNS resolution failed for ${hostname}`);
  }

  if (!addresses || addresses.length === 0) {
    throw new EgressBlockedError(`No addresses resolved for ${hostname}`);
  }

  // Fail closed if ANY resolved address is private — defeats round-robin
  // DNS that mixes a public and a private answer.
  for (const { address } of addresses) {
    if (!allowPrivate && isBlockedAddress(address)) {
      throw new EgressBlockedError(`Blocked resolved address for ${hostname}: ${address}`);
    }
  }

  const chosen = addresses[0];
  return { url, pinnedIp: chosen.address, family: chosen.family };
}

type UndiciInit = NonNullable<Parameters<typeof undiciFetch>[1]>;
type UndiciResponse = Awaited<ReturnType<typeof undiciFetch>>;

/** Headers that must not follow a redirect to a different origin. */
const CROSS_ORIGIN_STRIP = ['authorization', 'cookie', 'proxy-authorization', 'x-project-key'];

function stripSensitiveHeaders(headers: UndiciInit['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  const h = new Headers(headers as HeadersInit | undefined);
  h.forEach((value, key) => {
    if (!CROSS_ORIGIN_STRIP.includes(key.toLowerCase())) out[key] = value;
  });
  return out;
}

/**
 * One validated, IP-pinned request with `redirect: 'manual'`. The undici
 * connector's `lookup` is invoked by net/tls.connect, which on current Node
 * (autoSelectFamily / happy-eyeballs) passes `{ all: true }` and REQUIRES an
 * array result; on older paths it expects `(err, address, family)`. Honour
 * both, otherwise Node throws ERR_INVALID_IP_ADDRESS (F-08).
 */
async function pinnedRequest(
  rawUrl: string,
  init: UndiciInit,
  options: EgressGuardOptions,
): Promise<UndiciResponse> {
  const { url, pinnedIp, family } = await assertPublicUrl(rawUrl, options);

  const agent = new Agent({
    connect: {
      lookup: ((_hostname: string, opts: { all?: boolean } | undefined, cb: (...args: unknown[]) => void) => {
        if (opts && opts.all) {
          cb(null, [{ address: pinnedIp, family }]);
        } else {
          cb(null, pinnedIp, family);
        }
      }) as never,
    },
  });

  try {
    return await undiciFetch(url, { ...init, redirect: 'manual', dispatcher: agent } as UndiciInit);
  } finally {
    // Graceful close: lets the in-flight response body finish streaming.
    agent.close().catch(() => {});
  }
}

/**
 * SSRF-safe replacement for `fetch`. Every hop (the original URL and each
 * redirect target) is validated with `assertPublicUrl` (DNS + scheme + every
 * resolved address public) and then connected through a per-hop undici Agent
 * whose `lookup` always returns the vetted IP, so the socket can't be rebound
 * to an internal address between validation and connection.
 *
 * Redirects: undici's own redirect handling would silently connect to
 * un-validated targets, so the underlying request is always
 * `redirect: 'manual'`. By default (`init.redirect` unset / `'follow'`) this
 * function follows up to {@link SAFE_FETCH_MAX_REDIRECTS} redirects itself,
 * re-validating + re-pinning each hop. `redirect: 'manual'` returns the 3xx
 * response to the caller (the review proxy follows hops itself);
 * `redirect: 'error'` rejects on any redirect.
 *
 * `init` mirrors the standard fetch init (method, headers, body, signal…).
 */
export async function safeFetch(
  rawUrl: string,
  init: Parameters<typeof undiciFetch>[1] = {},
  options: EgressGuardOptions = {},
): Promise<UndiciResponse> {
  const mode = init.redirect ?? 'follow';
  let currentUrl = rawUrl;
  let currentInit: UndiciInit = { ...init };

  for (let hop = 0; ; hop++) {
    const response = await pinnedRequest(currentUrl, currentInit, options);

    const isRedirect = [301, 302, 303, 307, 308].includes(response.status);
    const location = response.headers.get('location');
    if (!isRedirect || !location || mode === 'manual') return response;

    // Discard the redirect body so the socket is released.
    await response.body?.cancel().catch(() => {});

    if (mode === 'error') {
      throw new EgressBlockedError(`Unexpected redirect to ${location}`);
    }
    if (hop >= SAFE_FETCH_MAX_REDIRECTS) {
      throw new EgressBlockedError('Too many redirects');
    }

    let next: URL;
    try {
      next = new URL(location, currentUrl);
    } catch {
      throw new EgressBlockedError('Invalid redirect location');
    }

    const method = (currentInit.method ?? 'GET').toUpperCase();
    const toGet =
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) && method === 'POST');
    const nextInit: UndiciInit = { ...currentInit };
    if (toGet) {
      nextInit.method = 'GET';
      delete (nextInit as { body?: unknown }).body;
    } else if (nextInit.body != null && typeof nextInit.body !== 'string' && !Buffer.isBuffer(nextInit.body)) {
      // A streamed body is consumed; it cannot be replayed on 307/308.
      throw new EgressBlockedError('Cannot replay a streamed body across a redirect');
    }
    if (next.origin !== new URL(currentUrl).origin) {
      nextInit.headers = stripSensitiveHeaders(nextInit.headers);
    }
    currentInit = nextInit;
    currentUrl = next.toString();
    // Loop: the next iteration re-runs assertPublicUrl + pinning for this hop.
  }
}

/**
 * Read a fetch Response body as UTF-8 text, consuming AT MOST `maxBytes`
 * from the network. Unlike `await response.text()` (which buffers the whole
 * body before any size check), this aborts the stream once the cap is
 * reached, so a hostile endpoint streaming a multi-GB chunked body cannot
 * exhaust memory. Returns `{ text, truncated }`; `truncated` is true when the
 * body exceeded the cap (the caller decides whether to reject or keep the
 * prefix). Never throws for a body read error — returns what was read.
 */
export async function readBodyCapped(
  response: { body?: ReadableStream<Uint8Array> | null; text?: () => Promise<string> },
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) {
    // Non-streaming response objects (no `body`): fall back to text(), then
    // apply the same byte cap. Real undici responses always take the
    // streamed path below.
    if (!response.text) return { text: '', truncated: false };
    const full = await response.text().catch(() => '');
    const buf = Buffer.from(full, 'utf8');
    if (buf.byteLength <= maxBytes) return { text: full, truncated: false };
    return { text: new TextDecoder('utf-8').decode(buf.subarray(0, maxBytes)), truncated: true };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = maxBytes - total;
      if (value.byteLength > room) {
        if (room > 0) chunks.push(value.subarray(0, room));
        total = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    // Network error mid-body: keep what we have.
  } finally {
    // Stop pulling from the socket; ignore cancel errors.
    reader.cancel().catch(() => {});
  }
  // TextDecoder in non-fatal mode drops a split trailing multi-byte char.
  const text = new TextDecoder('utf-8').decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
  return { text, truncated };
}
