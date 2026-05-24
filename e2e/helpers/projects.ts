/**
 * Project lifecycle helpers shared across the e2e specs.
 *
 * Every spec that exercises a project-scoped flow (auth → CSRF, multi-URL
 * page creation, shared-link lockout) opens a fresh project, runs its
 * assertions, and then deletes the project so the test database stays
 * predictable across runs. `withTemporaryProject` factors that
 * setup/teardown into a single helper so each spec can focus on the
 * assertion under test.
 *
 * Delete requires `confirmationToken` per Req 2.7; we always pass the
 * project's name. If the inner callback throws, the cleanup still
 * runs (`finally`) so a failing test doesn't leak rows.
 */
import type { APIRequestContext } from '@playwright/test';

import type { AuthSession } from './auth.js';
import { API_BASE_URL } from './stack.js';

export interface TemporaryProjectPage {
  id: string;
  projectId: string;
  url: string;
  title: string | null;
  createdAt: string;
}

export interface TemporaryProject {
  id: string;
  name: string;
  urls: string[];
  /**
   * `pages` rows created alongside the project (Req 23.1) — one entry per
   * unique URL. Exposed so callers asserting on the multi-URL → multi-page
   * mapping don't need a follow-up request.
   */
  pages: TemporaryProjectPage[];
}

export interface TemporaryProjectAttrs {
  name: string;
  urls: string[];
  teamId?: string;
}

/**
 * Create a project, hand it to `fn`, then delete it (regardless of whether
 * `fn` throws). Returns whatever `fn` returns so the caller can chain
 * assertions on the resolved value.
 */
export async function withTemporaryProject<T>(
  request: APIRequestContext,
  session: AuthSession,
  attrs: TemporaryProjectAttrs,
  fn: (project: TemporaryProject) => Promise<T>,
): Promise<T> {
  const createRes = await request.post(`${API_BASE_URL}/api/v1/projects`, {
    data: attrs,
    headers: session.mutatingHeaders(),
  });
  if (!createRes.ok()) {
    throw new Error(
      `withTemporaryProject: create failed ${createRes.status()} ${await createRes.text()}`,
    );
  }
  const body = (await createRes.json()) as {
    project: { id: string; name: string; urls: string[] };
    pages: TemporaryProjectPage[];
  };
  const project: TemporaryProject = {
    id: body.project.id,
    name: body.project.name,
    urls: body.project.urls,
    pages: body.pages,
  };
  try {
    return await fn(project);
  } finally {
    await request.delete(`${API_BASE_URL}/api/v1/projects/${project.id}`, {
      data: { confirmationToken: project.name },
      headers: session.mutatingHeaders(),
    });
  }
}
