// Dependency-free AWS Signature V4 query-string presigner for S3 GET.
//
// Screenshot buckets are private, so the raw object URL returned by
// `S3ScreenshotStore.buildScreenshotUrl` answers 403 to a browser `<img>`.
// This produces a short-lived, self-authorising URL instead. It is kept
// local (≈50 LOC of node:crypto) rather than adding
// `@aws-sdk/s3-request-presigner` as a repo dependency.

import crypto from 'node:crypto';

export interface PresignCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string | undefined;
}

export interface PresignGetInput {
  /** Plain object URL (path-style endpoint or virtual-hosted AWS URL). */
  url: string;
  region: string;
  credentials: PresignCredentials;
  /** Lifetime in seconds (S3 max is 7 days). */
  expiresInSeconds: number;
  /** Injectable clock for deterministic tests. */
  now?: Date;
}

const hmac = (key: crypto.BinaryLike | crypto.KeyObject, data: string): Buffer =>
  crypto.createHmac('sha256', key).update(data, 'utf8').digest();

/** RFC 3986 encode (what SigV4 requires): everything but unreserved chars. */
const rfc3986 = (s: string): string =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function presignGetUrl(input: PresignGetInput): string {
  const u = new URL(input.url);
  const now = input.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${input.region}/s3/aws4_request`;

  const params: Array<[string, string]> = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${input.credentials.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(input.expiresInSeconds)],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  if (input.credentials.sessionToken) {
    params.push(['X-Amz-Security-Token', input.credentials.sessionToken]);
  }
  const query = params
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  // S3 canonical URI: each path segment encoded exactly once.
  const canonicalPath = u.pathname
    .split('/')
    .map((seg) => rfc3986(decodeURIComponent(seg)))
    .join('/');
  const canonicalRequest = [
    'GET',
    canonicalPath,
    query,
    `host:${u.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    crypto.createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
  ].join('\n');

  const kDate = hmac(`AWS4${input.credentials.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  return `${u.protocol}//${u.host}${canonicalPath}?${query}&X-Amz-Signature=${signature}`;
}
