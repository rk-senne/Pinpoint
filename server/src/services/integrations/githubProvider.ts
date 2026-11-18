// GitHub Issues adapter (C4). Opens an issue via the REST v3 API:
//   POST https://api.github.com/repos/{owner}/{repo}/issues
// Auth: `Authorization: Bearer <token>` (fine-grained PAT or OAuth token).
// Required config: `owner`, `repo`.

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

const GITHUB_API = 'https://api.github.com';

/** Compose the issue body as GitHub-flavoured markdown. */
function renderBody(task: TaskInput): string {
  const lines = [task.body, '', `**Severity:** ${task.severity}`, '', `[View in Pinpoint](${task.url})`];
  return lines.join('\n');
}

export function createGithubProvider(deps: TaskProviderDeps = {}): TaskProvider {
  const doFetch = deps.safeFetch ?? defaultSafeFetch;
  const egressOptions = deps.egressOptions ?? {};

  return {
    provider: 'github',
    async createTask(ctx: TaskContext, task: TaskInput): Promise<TaskResult> {
      const owner = requireConfig(ctx.config, 'owner', 'github');
      const repo = requireConfig(ctx.config, 'repo', 'github');
      const url = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`;

      let res: Awaited<ReturnType<typeof doFetch>>;
      try {
        res = await doFetch(
          url,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${ctx.accessToken}`,
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
              'User-Agent': 'Pinpoint',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              title: task.title,
              body: renderBody(task),
              ...(task.labels.length > 0 ? { labels: task.labels } : {}),
            }),
          },
          egressOptions,
        );
      } catch (err) {
        throw new TaskDeliveryError(`GitHub request failed: ${(err as Error).message}`, { transient: true });
      }

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new TaskDeliveryError(describeUpstreamError(res.status, body), {
          transient: isTransientStatus(res.status),
          status: res.status,
        });
      }

      const data = (await res.json()) as { number?: number; html_url?: string };
      if (data.number === undefined || !data.html_url) {
        throw new TaskDeliveryError('GitHub response missing issue number/url', { transient: false });
      }
      return { externalId: String(data.number), externalUrl: data.html_url };
    },
  };
}
