// ClickUp adapter (C4). Creates a task via API v2:
//   POST https://api.clickup.com/api/v2/list/{listId}/task
// Auth: `Authorization: <token>` — ClickUp sends the personal/OAuth token
// WITHOUT a `Bearer ` prefix. Required config: `listId`.

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

const CLICKUP_API = 'https://api.clickup.com/api/v2';

function renderDescription(task: TaskInput): string {
  return [task.body, '', `Severity: ${task.severity}`, '', `View in Pinpoint: ${task.url}`].join('\n');
}

export function createClickUpProvider(deps: TaskProviderDeps = {}): TaskProvider {
  const doFetch = deps.safeFetch ?? defaultSafeFetch;
  const egressOptions = deps.egressOptions ?? {};

  return {
    provider: 'clickup',
    async createTask(ctx: TaskContext, task: TaskInput): Promise<TaskResult> {
      const listId = requireConfig(ctx.config, 'listId', 'clickup');
      const url = `${CLICKUP_API}/list/${encodeURIComponent(listId)}/task`;

      let res: Awaited<ReturnType<typeof doFetch>>;
      try {
        res = await doFetch(
          url,
          {
            method: 'POST',
            headers: {
              Authorization: ctx.accessToken,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              name: task.title,
              description: renderDescription(task),
              ...(task.labels.length > 0 ? { tags: task.labels } : {}),
            }),
          },
          egressOptions,
        );
      } catch (err) {
        throw new TaskDeliveryError(`ClickUp request failed: ${(err as Error).message}`, { transient: true });
      }

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        let message = describeUpstreamError(res.status, body);
        if (body && typeof body === 'object' && typeof (body as { err?: string }).err === 'string') {
          message = `${res.status}: ${(body as { err: string }).err}`;
        }
        throw new TaskDeliveryError(message, {
          transient: isTransientStatus(res.status),
          status: res.status,
        });
      }

      const data = (await res.json()) as { id?: string; url?: string };
      if (!data.id) {
        throw new TaskDeliveryError('ClickUp response missing task id', { transient: false });
      }
      return { externalId: data.id, externalUrl: data.url ?? `https://app.clickup.com/t/${data.id}` };
    },
  };
}
