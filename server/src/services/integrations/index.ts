// C4 — task-provider registry. Maps a provider name to its adapter factory
// so the deliver route can resolve a `TaskProvider` without a switch. All
// adapters share the same injectable deps (stubbed `safeFetch` in tests).

import {
  type TaskProvider,
  type TaskProviderDeps,
  type TaskProviderName,
  TASK_PROVIDERS,
} from './TaskProvider.js';
import { createGithubProvider } from './githubProvider.js';
import { createLinearProvider } from './linearProvider.js';
import { createJiraProvider } from './jiraProvider.js';
import { createClickUpProvider } from './clickupProvider.js';
import { createAsanaProvider } from './asanaProvider.js';
import { createSlackProvider } from './slackProvider.js';

export {
  type TaskProvider,
  type TaskProviderDeps,
  type TaskProviderName,
  type TaskContext,
  type TaskInput,
  type TaskResult,
  TASK_PROVIDERS,
  isTaskProvider,
  TaskDeliveryError,
} from './TaskProvider.js';

export { createGithubProvider } from './githubProvider.js';
export { createLinearProvider } from './linearProvider.js';
export { createJiraProvider } from './jiraProvider.js';
export { createClickUpProvider } from './clickupProvider.js';
export { createAsanaProvider } from './asanaProvider.js';
export { createSlackProvider } from './slackProvider.js';
export {
  createSlackAnnotationNotifier,
  createSlackQueueDelivery,
  withSlackAutoNotify,
  SLACK_NOTIFICATION_KIND,
} from './slackNotifier.js';
export { createSlackWiring, type SlackWiring } from './slackWiring.js';

type Factory = (deps: TaskProviderDeps) => TaskProvider;

const FACTORIES: Record<TaskProviderName, Factory> = {
  github: createGithubProvider,
  linear: createLinearProvider,
  jira: createJiraProvider,
  clickup: createClickUpProvider,
  asana: createAsanaProvider,
  slack: createSlackProvider,
};

/**
 * Build the full set of provider adapters keyed by name. Call once at
 * composition time (or per-request with a stubbed fetch in tests).
 */
export function createTaskProviders(deps: TaskProviderDeps = {}): Record<TaskProviderName, TaskProvider> {
  const out = {} as Record<TaskProviderName, TaskProvider>;
  for (const name of TASK_PROVIDERS) {
    out[name] = FACTORIES[name](deps);
  }
  return out;
}
