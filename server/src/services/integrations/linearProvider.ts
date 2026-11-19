// Linear adapter (C4). Creates an issue via the GraphQL API:
//   POST https://api.linear.app/graphql  (issueCreate mutation)
// Auth: `Authorization: <token>` — Linear uses the raw API key / OAuth
// access token WITHOUT a `Bearer ` prefix for personal API keys, but OAuth
// tokens are sent as `Bearer <token>`. We send the token verbatim when it
// already looks prefixed, else as-is (Linear accepts the raw key).
// Required config: `teamId`.

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

const LINEAR_API = 'https://api.linear.app/graphql';

const ISSUE_CREATE = `
mutation IssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue { id identifier url }
  }
}`.trim();

function renderDescription(task: TaskInput): string {
  return [task.body, '', `**Severity:** ${task.severity}`, '', `[View in Pinpoint](${task.url})`].join('\n');
}

/**
 * Linear OAuth tokens are sent as `Bearer <token>`; personal API keys
 * (prefix `lin_api_`) are sent raw. Detect and format accordingly.
 */
function authHeader(token: string): string {
  if (token.startsWith('lin_api_')) return token;
  return `Bearer ${token}`;
}

export function createLinearProvider(deps: TaskProviderDeps = {}): TaskProvider {
  const doFetch = deps.safeFetch ?? defaultSafeFetch;
  const egressOptions = deps.egressOptions ?? {};

  return {
    provider: 'linear',
    async createTask(ctx: TaskContext, task: TaskInput): Promise<TaskResult> {
      const teamId = requireConfig(ctx.config, 'teamId', 'linear');

      let res: Awaited<ReturnType<typeof doFetch>>;
      try {
        res = await doFetch(
          LINEAR_API,
          {
            method: 'POST',
            headers: {
              Authorization: authHeader(ctx.accessToken),
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              query: ISSUE_CREATE,
              variables: {
                input: {
                  teamId,
                  title: task.title,
                  description: renderDescription(task),
                },
              },
            }),
          },
          egressOptions,
        );
      } catch (err) {
        throw new TaskDeliveryError(`Linear request failed: ${(err as Error).message}`, { transient: true });
      }

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new TaskDeliveryError(describeUpstreamError(res.status, body), {
          transient: isTransientStatus(res.status),
          status: res.status,
        });
      }

      const data = (await res.json()) as {
        data?: { issueCreate?: { success?: boolean; issue?: { id: string; identifier: string; url: string } } };
        errors?: Array<{ message?: string }>;
      };

      // GraphQL returns 200 with an `errors` array on failure.
      if (data.errors && data.errors.length > 0) {
        const msg = data.errors[0]?.message ?? 'Linear GraphQL error';
        throw new TaskDeliveryError(`Linear: ${msg}`, { transient: false, status: 200 });
      }

      const issue = data.data?.issueCreate?.issue;
      if (!data.data?.issueCreate?.success || !issue) {
        throw new TaskDeliveryError('Linear issueCreate returned no issue', { transient: false });
      }
      return { externalId: issue.identifier || issue.id, externalUrl: issue.url };
    },
  };
}
