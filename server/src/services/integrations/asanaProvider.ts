// Asana adapter (C4). Creates a task via API v1:
//   POST https://app.asana.com/api/1.0/tasks
// Auth: `Authorization: Bearer <token>` (PAT or OAuth access token).
// Required config: `projectGid`. Asana wraps request + response in `data`.

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

const ASANA_API = 'https://app.asana.com/api/1.0';

function renderNotes(task: TaskInput): string {
  return [task.body, '', `Severity: ${task.severity}`, '', `View in Pinpoint: ${task.url}`].join('\n');
}

export function createAsanaProvider(deps: TaskProviderDeps = {}): TaskProvider {
  const doFetch = deps.safeFetch ?? defaultSafeFetch;
  const egressOptions = deps.egressOptions ?? {};

  return {
    provider: 'asana',
    async createTask(ctx: TaskContext, task: TaskInput): Promise<TaskResult> {
      const projectGid = requireConfig(ctx.config, 'projectGid', 'asana');
      const url = `${ASANA_API}/tasks`;

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
              data: {
                name: task.title,
                notes: renderNotes(task),
                projects: [projectGid],
              },
            }),
          },
          egressOptions,
        );
      } catch (err) {
        throw new TaskDeliveryError(`Asana request failed: ${(err as Error).message}`, { transient: true });
      }

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        let message = describeUpstreamError(res.status, body);
        if (body && typeof body === 'object') {
          const errors = (body as { errors?: Array<{ message?: string }> }).errors;
          if (Array.isArray(errors) && typeof errors[0]?.message === 'string') {
            message = `${res.status}: ${errors[0].message}`;
          }
        }
        throw new TaskDeliveryError(message, {
          transient: isTransientStatus(res.status),
          status: res.status,
        });
      }

      const data = (await res.json()) as { data?: { gid?: string; permalink_url?: string } };
      const gid = data.data?.gid;
      if (!gid) {
        throw new TaskDeliveryError('Asana response missing task gid', { transient: false });
      }
      return { externalId: gid, externalUrl: data.data?.permalink_url ?? `${ASANA_API}/tasks/${gid}` };
    },
  };
}
