// Jira Cloud adapter (C4). Creates an issue via REST API v3:
//   POST https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/issue
// The v3 API requires the description as an Atlassian Document Format (ADF)
// document, not plain text. Auth: OAuth 2.0 (3LO) bearer access token.
// Required config: `cloudId`, `projectKey`. Optional `issueType` (default 'Task').

import {
  type TaskContext,
  type TaskInput,
  type TaskProvider,
  type TaskProviderDeps,
  type TaskResult,
  TaskDeliveryError,
  describeUpstreamError,
  isTransientStatus,
  requireConfig,
} from './TaskProvider.js';
import { safeFetch as defaultSafeFetch } from '../egressGuard.js';

const ATLASSIAN_API = 'https://api.atlassian.com';

/**
 * Build a minimal ADF document: the body as a paragraph, a severity
 * paragraph, and a link back to Pinpoint. Keeping it to paragraphs + a link
 * mark avoids depending on any ADF node type a site might have disabled.
 */
function buildAdf(task: TaskInput): Record<string, unknown> {
  return {
    type: 'doc',
    version: 1,
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: task.body }] },
      { type: 'paragraph', content: [{ type: 'text', text: `Severity: ${task.severity}` }] },
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'View in Pinpoint',
            marks: [{ type: 'link', attrs: { href: task.url } }],
          },
        ],
      },
    ],
  };
}

export function createJiraProvider(deps: TaskProviderDeps = {}): TaskProvider {
  const doFetch = deps.safeFetch ?? defaultSafeFetch;
  const egressOptions = deps.egressOptions ?? {};

  return {
    provider: 'jira',
    async createTask(ctx: TaskContext, task: TaskInput): Promise<TaskResult> {
      const cloudId = requireConfig(ctx.config, 'cloudId', 'jira');
      const projectKey = requireConfig(ctx.config, 'projectKey', 'jira');
      const issueType = typeof ctx.config.issueType === 'string' && ctx.config.issueType
        ? ctx.config.issueType
        : 'Task';
      const url = `${ATLASSIAN_API}/ex/jira/${encodeURIComponent(cloudId)}/rest/api/3/issue`;

      let res: Awaited<ReturnType<typeof doFetch>>;
      try {
        res = await doFetch(
          url,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${ctx.accessToken}`,
              Accept: 'application/json',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              fields: {
                project: { key: projectKey },
                summary: task.title,
                description: buildAdf(task),
                issuetype: { name: issueType },
              },
            }),
          },
          egressOptions,
        );
      } catch (err) {
        throw new TaskDeliveryError(`Jira request failed: ${(err as Error).message}`, { transient: true });
      }

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        // Jira surfaces field errors under `errors` (object) and `errorMessages` (array).
        let message = describeUpstreamError(res.status, body);
        if (body && typeof body === 'object') {
          const b = body as { errorMessages?: unknown; errors?: Record<string, unknown> };
          if (Array.isArray(b.errorMessages) && typeof b.errorMessages[0] === 'string') {
            message = `${res.status}: ${b.errorMessages[0]}`;
          } else if (b.errors && typeof b.errors === 'object') {
            const first = Object.values(b.errors)[0];
            if (typeof first === 'string') message = `${res.status}: ${first}`;
          }
        }
        throw new TaskDeliveryError(message, {
          transient: isTransientStatus(res.status),
          status: res.status,
        });
      }

      const data = (await res.json()) as { key?: string; id?: string };
      if (!data.key) {
        throw new TaskDeliveryError('Jira response missing issue key', { transient: false });
      }
      // The site base is not returned by the API; build a stable browse URL
      // from the configured `siteUrl` when present, else leave a REST ref.
      const siteUrl = typeof ctx.config.siteUrl === 'string' ? ctx.config.siteUrl.replace(/\/$/, '') : '';
      const externalUrl = siteUrl
        ? `${siteUrl}/browse/${data.key}`
        : `${ATLASSIAN_API}/ex/jira/${cloudId}/rest/api/3/issue/${data.key}`;
      return { externalId: data.key, externalUrl };
    },
  };
}
