// Slack delivery adapter. Posts an annotation to a chosen channel with
// `chat.postMessage` (Block Kit) and returns the message permalink from
// `chat.getPermalink` as the "external link", exactly like the trackers'
// issue URLs.
//
// Auth: the bot token (`xoxb-…`, stored encrypted, decrypted by the repo) as
// `Authorization: Bearer`. All HTTP goes through `safeFetch`; the token is
// never logged or put into an error message.
// Required config: `channelId` (+ optional `channelName`, used for messages).
//
// Slack answers HTTP 200 with `{ ok: false, error }` for most failures, and
// HTTP 429 + `Retry-After` when rate limited; both are mapped to a
// `TaskDeliveryError` (transient for rate limits and Slack-side faults).

import {
  type TaskContext,
  type TaskInput,
  type TaskProvider,
  type TaskProviderDeps,
  type TaskResult,
  TaskDeliveryError,
  isTransientStatus,
  requireConfig,
} from './TaskProvider.js';
import { readBodyCapped, safeFetch as defaultSafeFetch } from '../egressGuard.js';

const SLACK_API = 'https://slack.com/api';
const MAX_BODY_BYTES = 256 * 1024;
const TIMEOUT_MS = 10_000;
/** Slack section text limit is 3000 chars; stay well under it. */
const MAX_BODY_CHARS = 2500;

/** Escape the three characters Slack mrkdwn treats as control (`& < >`). */
export function escapeSlackMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Make a URL safe inside a Slack `<url|label>` link (no `<`, `>`, `|`, spaces). */
function slackLinkUrl(url: string): string | null {
  if (!/^https?:\/\//i.test(url)) return null;
  return url.replace(/[<>|\s]/g, (c) => encodeURIComponent(c));
}

function link(url: string | null | undefined, label: string): string | null {
  if (!url) return null;
  const safe = slackLinkUrl(url);
  return safe ? `<${safe}|${escapeSlackMrkdwn(label)}>` : null;
}

const SEVERITY_EMOJI: Record<string, string> = {
  critical: ':red_circle: ',
  major: ':large_orange_circle: ',
  minor: ':large_yellow_circle: ',
  informational: ':large_blue_circle: ',
};

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Build the `chat.postMessage` payload (without `channel`). Exported for tests. */
export function buildSlackMessage(task: TaskInput): { text: string; blocks: unknown[] } {
  const sevKey = task.severity.toLowerCase();
  const pin = task.pinNumber != null && task.pinNumber !== '' ? `#${task.pinNumber}` : null;
  const heading = `Pinpoint feedback${pin ? ` ${pin}` : ''}`;
  const fields: Array<{ type: 'mrkdwn'; text: string }> = [
    { type: 'mrkdwn', text: `*Severity*\n${SEVERITY_EMOJI[sevKey] ?? ''}${escapeSlackMrkdwn(task.severity)}` },
  ];
  if (task.annotationType) fields.push({ type: 'mrkdwn', text: `*Type*\n${escapeSlackMrkdwn(task.annotationType)}` });
  if (task.status) fields.push({ type: 'mrkdwn', text: `*Status*\n${escapeSlackMrkdwn(task.status)}` });
  const page = link(task.pageUrl, truncate(task.pageUrl ?? '', 100));
  if (page) fields.push({ type: 'mrkdwn', text: `*Page*\n${page}` });

  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: truncate(heading, 150), emoji: true } },
    { type: 'section', fields },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: escapeSlackMrkdwn(truncate(task.body, MAX_BODY_CHARS)) || '_(no text)_' },
    },
  ];
  const open = link(task.projectUrl ?? task.url, 'Open in Pinpoint');
  if (open) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: open }] });

  // `text` is the notification / accessibility fallback (mrkdwn-parsed too).
  const text = truncate(`${heading} (${task.severity}): ${task.body.replace(/\s+/g, ' ')}`, 200);
  return { text: escapeSlackMrkdwn(text), blocks };
}

/** Slack `error` code → message + whether re-sending can help. */
export function mapSlackError(code: string, channelLabel: string): { message: string; transient: boolean } {
  switch (code) {
    case 'channel_not_found':
      return {
        message: `Slack channel ${channelLabel} was not found. Pick the channel again in Integrations → Slack.`,
        transient: false,
      };
    case 'not_in_channel':
      return {
        message: `The Pinpoint bot is not in ${channelLabel}. Invite it there (/invite @Pinpoint) and retry.`,
        transient: false,
      };
    case 'is_archived':
      return { message: `Slack channel ${channelLabel} is archived. Pick another channel.`, transient: false };
    case 'invalid_auth':
    case 'not_authed':
    case 'token_revoked':
    case 'token_expired':
    case 'account_inactive':
      return { message: 'Slack rejected the stored token. Reconnect Slack in Integrations.', transient: false };
    case 'missing_scope':
      return {
        message: 'The Slack app is missing a required scope (chat:write, channels:read). Reconnect Slack.',
        transient: false,
      };
    case 'msg_too_long':
      return { message: 'The annotation is too long for a Slack message.', transient: false };
    case 'ratelimited':
    case 'rate_limited':
      return { message: 'Slack is rate limiting requests. Try again shortly.', transient: true };
    case 'internal_error':
    case 'fatal_error':
    case 'service_unavailable':
    case 'request_timeout':
      return { message: `Slack had a temporary problem (${code}). Try again.`, transient: true };
    default:
      return { message: `Slack error: ${code}`, transient: false };
  }
}

/** Parse `Retry-After` (seconds); clamps to 1..3600. */
export function parseRetryAfter(res: { headers?: { get?: (n: string) => string | null } }): number | undefined {
  const raw = res.headers?.get?.('retry-after');
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.ceil(n), 3600) : undefined;
}

export function createSlackProvider(deps: TaskProviderDeps = {}): TaskProvider {
  const doFetch = deps.safeFetch ?? defaultSafeFetch;
  const egressOptions = deps.egressOptions ?? {};

  /** One Slack Web API call → parsed JSON (`ok: true`) or a thrown TaskDeliveryError. */
  async function slackCall(
    method: string,
    token: string,
    init: { method: 'GET' | 'POST'; query?: Record<string, string>; json?: unknown },
    channelLabel: string,
  ): Promise<Record<string, unknown>> {
    const url = new URL(`${SLACK_API}/${method}`);
    for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);

    let res: Awaited<ReturnType<typeof doFetch>>;
    try {
      res = await doFetch(
        url.toString(),
        {
          method: init.method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(init.json !== undefined ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
          },
          ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
          redirect: 'error',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
        egressOptions,
      );
    } catch (err) {
      throw new TaskDeliveryError(`Slack request failed: ${(err as Error).message}`, { transient: true });
    }

    if (res.status === 429) {
      const retryAfterSeconds = parseRetryAfter(res as never);
      throw new TaskDeliveryError(
        `Slack is rate limiting requests${retryAfterSeconds ? ` (retry in ${retryAfterSeconds}s)` : ''}.`,
        { transient: true, status: 429, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) },
      );
    }
    if (!res.ok) {
      throw new TaskDeliveryError(`Upstream responded with HTTP ${res.status}`, {
        transient: isTransientStatus(res.status),
        status: res.status,
      });
    }

    const { text, truncated } = await readBodyCapped(res as never, MAX_BODY_BYTES);
    let json: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = truncated ? null : JSON.parse(text);
      json = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      json = null;
    }
    if (!json) throw new TaskDeliveryError('Slack returned an unreadable response.', { transient: true });
    if (json.ok !== true) {
      const code = typeof json.error === 'string' ? json.error : 'unknown_error';
      const mapped = mapSlackError(code, channelLabel);
      throw new TaskDeliveryError(mapped.message, { transient: mapped.transient, status: 200 });
    }
    return json;
  }

  return {
    provider: 'slack',
    async createTask(ctx: TaskContext, task: TaskInput): Promise<TaskResult> {
      const channel = requireConfig(ctx.config, 'channelId', 'slack');
      const name = typeof ctx.config.channelName === 'string' ? ctx.config.channelName : '';
      const channelLabel = name ? `#${name.replace(/^#/, '')}` : channel;

      const posted = await slackCall(
        'chat.postMessage',
        ctx.accessToken,
        { method: 'POST', json: { channel, ...buildSlackMessage(task), unfurl_links: false, unfurl_media: false } },
        channelLabel,
      );
      const ts = typeof posted.ts === 'string' ? posted.ts : '';
      const postedChannel = typeof posted.channel === 'string' ? posted.channel : channel;
      if (!ts) throw new TaskDeliveryError('Slack did not return a message timestamp.', { transient: false });

      // The message is already posted: a permalink failure must NOT fail the
      // delivery (a retry would double-post). Fall back to a redirect URL.
      let permalink: string | undefined;
      try {
        const p = await slackCall(
          'chat.getPermalink',
          ctx.accessToken,
          { method: 'GET', query: { channel: postedChannel, message_ts: ts } },
          channelLabel,
        );
        if (typeof p.permalink === 'string' && p.permalink.startsWith('https://')) permalink = p.permalink;
      } catch {
        permalink = undefined;
      }
      return {
        externalId: `${postedChannel}:${ts}`,
        externalUrl:
          permalink ??
          `https://slack.com/app_redirect?channel=${encodeURIComponent(postedChannel)}&message_ts=${encodeURIComponent(ts)}`,
      };
    },
  };
}
