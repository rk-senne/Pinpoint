// C4 — one-click annotation → trackable task delivery.
//
// A `TaskProvider` is a small deep module (Ousterhout): a single `createTask`
// method hides the provider's wire protocol (REST vs GraphQL), auth header
// shape, ADF/markdown body formatting, and error mapping behind a uniform
// interface. Every adapter performs ALL outbound HTTP through `safeFetch`
// from `../egressGuard.js` so a malicious/misconfigured provider base URL
// can never be turned into an SSRF primitive, and NONE of them ever log the
// access token.

import type { safeFetch as defaultSafeFetch } from '../egressGuard.js';
import type { EgressGuardOptions } from '../egressGuard.js';

/** The canonical set of task-tracker providers C4 can deliver to. */
export const TASK_PROVIDERS = [
  'github',
  'linear',
  'jira',
  'clickup',
  'asana',
  // Slack is a delivery *channel* rather than a tracker, but it shares the
  // "Send to…" contract: it posts a message and returns its permalink.
  'slack',
] as const;

export type TaskProviderName = (typeof TASK_PROVIDERS)[number];

/** Narrowing guard — is `value` one of the supported task providers? */
export function isTaskProvider(value: string): value is TaskProviderName {
  return (TASK_PROVIDERS as readonly string[]).includes(value);
}

/**
 * The annotation, reduced to the fields a tracker needs to open an issue.
 * `url` is the deep link back into Pinpoint; `labels` are optional tag hints.
 */
export interface TaskInput {
  title: string;
  body: string;
  url: string;
  severity: string;
  labels: string[];
  /**
   * Optional richer context (used by the Slack adapter; trackers ignore it).
   * `annotationType` is note/suggestion/guideline, `projectUrl` is the
   * dashboard project page `${APP_URL}/projects/<id>`.
   */
  annotationType?: string;
  status?: string;
  pageUrl?: string | null;
  projectUrl?: string;
  pinNumber?: number | string | null;
}

/**
 * Per-call context. `accessToken` is the DECRYPTED OAuth/PAT bearer for the
 * provider (PgIntegrationRepo decrypts on read). `config` is the integration's
 * stored config JSON — each adapter reads only the target keys it needs
 * (repo owner/name, Linear teamId, Jira cloudId+projectKey, ClickUp listId,
 * Asana projectGid).
 */
export interface TaskContext {
  accessToken: string;
  config: Record<string, unknown>;
}

/** The identifiers a successful delivery yields back. */
export interface TaskResult {
  externalId: string;
  externalUrl: string;
}

/** Injectable deps so adapters are unit-testable with a stubbed fetch. */
export interface TaskProviderDeps {
  safeFetch?: typeof defaultSafeFetch;
  egressOptions?: EgressGuardOptions;
}

/**
 * A provider adapter. Implementations throw `TaskDeliveryError` on failure so
 * the route can map transient vs permanent and record `last_error` without
 * leaking the token.
 */
export interface TaskProvider {
  readonly provider: TaskProviderName;
  createTask(ctx: TaskContext, task: TaskInput): Promise<TaskResult>;
}

/**
 * Error raised by every adapter. `transient` marks 5xx / network failures that
 * are worth re-delivering (POST again); `status` carries the upstream HTTP
 * status when there was one. The message never contains the access token.
 */
export class TaskDeliveryError extends Error {
  readonly transient: boolean;
  readonly status?: number;
  /** Upstream `Retry-After` (seconds) for rate-limited (429) responses. */
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    opts: { transient: boolean; status?: number; retryAfterSeconds?: number } = { transient: false },
  ) {
    super(message);
    this.name = 'TaskDeliveryError';
    this.transient = opts.transient;
    this.status = opts.status;
    this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}

/** A 5xx or a thrown network error is transient; 4xx is permanent. */
export function isTransientStatus(status: number): boolean {
  return status >= 500 && status <= 599;
}

/**
 * Read a required string from the integration config, throwing a permanent
 * `TaskDeliveryError` (misconfiguration — re-delivery won't help) when it is
 * missing or blank. Shared by every adapter so the error shape is uniform.
 */
export function requireConfig(
  config: Record<string, unknown>,
  key: string,
  provider: string,
): string {
  const value = config[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TaskDeliveryError(
      `${provider} integration is missing required config '${key}'`,
      { transient: false },
    );
  }
  return value;
}

/**
 * Pull a short, upstream-provided message out of a parsed error body without
 * echoing anything token-shaped. Falls back to the HTTP status line.
 */
export function describeUpstreamError(status: number, body: unknown): string {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    const candidate =
      (typeof b.message === 'string' && b.message) ||
      (typeof b.error === 'string' && b.error) ||
      (Array.isArray(b.errors) && typeof b.errors[0] === 'string' && b.errors[0]) ||
      (typeof b.error_description === 'string' && b.error_description);
    if (candidate) return `${status}: ${candidate}`;
  }
  return `Upstream responded with HTTP ${status}`;
}
