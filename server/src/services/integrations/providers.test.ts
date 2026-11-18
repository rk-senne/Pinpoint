import { describe, it, expect, vi } from 'vitest';

import { createGithubProvider } from './githubProvider.js';
import { createLinearProvider } from './linearProvider.js';
import { createJiraProvider } from './jiraProvider.js';
import { createClickUpProvider } from './clickupProvider.js';
import { createAsanaProvider } from './asanaProvider.js';
import { TaskDeliveryError, type TaskInput } from './TaskProvider.js';

const TASK: TaskInput = {
  title: '[Pinpoint #3] Button overlaps footer',
  body: 'The submit button overlaps the footer on mobile.',
  url: 'https://app.pinpoint.test/project/p1?annotation=a1',
  severity: 'Major',
  labels: ['pinpoint', 'major'],
};

function okJson(data: unknown, status = 201) {
  return { ok: status < 400, status, json: async () => data, text: async () => '' } as any;
}

function errJson(status: number, data: unknown) {
  return { ok: false, status, json: async () => data, text: async () => '' } as any;
}

describe('GitHub provider', () => {
  it('POSTs to the repo issues endpoint with bearer auth and maps the response', async () => {
    const safeFetch = vi.fn(async () =>
      okJson({ number: 42, html_url: 'https://github.com/acme/web/issues/42' }),
    ) as any;
    const provider = createGithubProvider({ safeFetch });

    const result = await provider.createTask(
      { accessToken: 'ghtok', config: { owner: 'acme', repo: 'web' } },
      TASK,
    );

    expect(result).toEqual({ externalId: '42', externalUrl: 'https://github.com/acme/web/issues/42' });
    const [url, init] = safeFetch.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/acme/web/issues');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer ghtok');
    expect(init.headers.Accept).toBe('application/vnd.github+json');
    const body = JSON.parse(init.body);
    expect(body.title).toBe(TASK.title);
    expect(body.body).toContain('View in Pinpoint');
    expect(body.labels).toEqual(['pinpoint', 'major']);
  });

  it('throws a permanent error on missing config', async () => {
    const safeFetch = vi.fn() as any;
    const provider = createGithubProvider({ safeFetch });
    await expect(
      provider.createTask({ accessToken: 't', config: {} }, TASK),
    ).rejects.toMatchObject({ transient: false });
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('maps a 500 to a transient error', async () => {
    const safeFetch = vi.fn(async () => errJson(500, { message: 'boom' })) as any;
    const provider = createGithubProvider({ safeFetch });
    await expect(
      provider.createTask({ accessToken: 't', config: { owner: 'a', repo: 'b' } }, TASK),
    ).rejects.toMatchObject({ transient: true, status: 500 });
  });

  it('maps a 422 to a permanent error', async () => {
    const safeFetch = vi.fn(async () => errJson(422, { message: 'Validation failed' })) as any;
    const provider = createGithubProvider({ safeFetch });
    await expect(
      provider.createTask({ accessToken: 't', config: { owner: 'a', repo: 'b' } }, TASK),
    ).rejects.toMatchObject({ transient: false, status: 422 });
  });

  it('treats a thrown network error as transient', async () => {
    const safeFetch = vi.fn(async () => {
      throw new Error('ECONNRESET');
    }) as any;
    const provider = createGithubProvider({ safeFetch });
    await expect(
      provider.createTask({ accessToken: 't', config: { owner: 'a', repo: 'b' } }, TASK),
    ).rejects.toMatchObject({ transient: true });
  });
});

describe('Linear provider', () => {
  it('POSTs the issueCreate GraphQL mutation and maps the issue', async () => {
    const safeFetch = vi.fn(async () =>
      okJson(
        {
          data: {
            issueCreate: {
              success: true,
              issue: { id: 'uuid-1', identifier: 'ENG-7', url: 'https://linear.app/acme/issue/ENG-7' },
            },
          },
        },
        200,
      ),
    ) as any;
    const provider = createLinearProvider({ safeFetch });

    const result = await provider.createTask(
      { accessToken: 'Bearer-style-oauth', config: { teamId: 'team-123' } },
      TASK,
    );

    expect(result).toEqual({ externalId: 'ENG-7', externalUrl: 'https://linear.app/acme/issue/ENG-7' });
    const [url, init] = safeFetch.mock.calls[0];
    expect(url).toBe('https://api.linear.app/graphql');
    expect(init.headers.Authorization).toBe('Bearer Bearer-style-oauth');
    const body = JSON.parse(init.body);
    expect(body.query).toContain('issueCreate');
    expect(body.variables.input.teamId).toBe('team-123');
    expect(body.variables.input.title).toBe(TASK.title);
  });

  it('sends a personal api key without a Bearer prefix', async () => {
    const safeFetch = vi.fn(async () =>
      okJson(
        { data: { issueCreate: { success: true, issue: { id: 'u', identifier: 'ENG-1', url: 'u' } } } },
        200,
      ),
    ) as any;
    const provider = createLinearProvider({ safeFetch });
    await provider.createTask({ accessToken: 'lin_api_abc', config: { teamId: 't' } }, TASK);
    expect(safeFetch.mock.calls[0][1].headers.Authorization).toBe('lin_api_abc');
  });

  it('maps a GraphQL errors array (HTTP 200) to a permanent error', async () => {
    const safeFetch = vi.fn(async () => okJson({ errors: [{ message: 'team not found' }] }, 200)) as any;
    const provider = createLinearProvider({ safeFetch });
    await expect(
      provider.createTask({ accessToken: 't', config: { teamId: 't' } }, TASK),
    ).rejects.toBeInstanceOf(TaskDeliveryError);
  });
});

describe('Jira provider', () => {
  it('POSTs to the cloud issue endpoint with an ADF description and maps the key', async () => {
    const safeFetch = vi.fn(async () => okJson({ id: '10001', key: 'PP-5' })) as any;
    const provider = createJiraProvider({ safeFetch });

    const result = await provider.createTask(
      {
        accessToken: 'jiratok',
        config: { cloudId: 'cloud-abc', projectKey: 'PP', siteUrl: 'https://acme.atlassian.net' },
      },
      TASK,
    );

    expect(result).toEqual({ externalId: 'PP-5', externalUrl: 'https://acme.atlassian.net/browse/PP-5' });
    const [url, init] = safeFetch.mock.calls[0];
    expect(url).toBe('https://api.atlassian.com/ex/jira/cloud-abc/rest/api/3/issue');
    expect(init.headers.Authorization).toBe('Bearer jiratok');
    const body = JSON.parse(init.body);
    expect(body.fields.project.key).toBe('PP');
    expect(body.fields.summary).toBe(TASK.title);
    // Description is an ADF doc, not a string.
    expect(body.fields.description.type).toBe('doc');
    expect(body.fields.description.version).toBe(1);
    expect(body.fields.issuetype.name).toBe('Task');
  });

  it('surfaces Jira errorMessages on failure', async () => {
    const safeFetch = vi.fn(async () =>
      errJson(400, { errorMessages: ['Field summary is required'], errors: {} }),
    ) as any;
    const provider = createJiraProvider({ safeFetch });
    await expect(
      provider.createTask({ accessToken: 't', config: { cloudId: 'c', projectKey: 'P' } }, TASK),
    ).rejects.toMatchObject({ transient: false, status: 400 });
  });
});

describe('ClickUp provider', () => {
  it('POSTs to the list task endpoint with a raw token header and maps the id/url', async () => {
    const safeFetch = vi.fn(async () =>
      okJson({ id: 'abc123', url: 'https://app.clickup.com/t/abc123' }),
    ) as any;
    const provider = createClickUpProvider({ safeFetch });

    const result = await provider.createTask(
      { accessToken: 'cutok', config: { listId: 'list-9' } },
      TASK,
    );

    expect(result).toEqual({ externalId: 'abc123', externalUrl: 'https://app.clickup.com/t/abc123' });
    const [url, init] = safeFetch.mock.calls[0];
    expect(url).toBe('https://api.clickup.com/api/v2/list/list-9/task');
    expect(init.headers.Authorization).toBe('cutok');
    const body = JSON.parse(init.body);
    expect(body.name).toBe(TASK.title);
    expect(body.tags).toEqual(['pinpoint', 'major']);
  });

  it('maps a ClickUp err body on failure', async () => {
    const safeFetch = vi.fn(async () => errJson(401, { err: 'Token invalid', ECODE: 'OAUTH_019' })) as any;
    const provider = createClickUpProvider({ safeFetch });
    await expect(
      provider.createTask({ accessToken: 't', config: { listId: 'l' } }, TASK),
    ).rejects.toMatchObject({ transient: false, status: 401 });
  });
});

describe('Asana provider', () => {
  it('POSTs to the tasks endpoint wrapping payload in data and maps the gid', async () => {
    const safeFetch = vi.fn(async () =>
      okJson({ data: { gid: '12345', permalink_url: 'https://app.asana.com/0/0/12345' } }),
    ) as any;
    const provider = createAsanaProvider({ safeFetch });

    const result = await provider.createTask(
      { accessToken: 'asanatok', config: { projectGid: 'proj-7' } },
      TASK,
    );

    expect(result).toEqual({ externalId: '12345', externalUrl: 'https://app.asana.com/0/0/12345' });
    const [url, init] = safeFetch.mock.calls[0];
    expect(url).toBe('https://app.asana.com/api/1.0/tasks');
    expect(init.headers.Authorization).toBe('Bearer asanatok');
    const body = JSON.parse(init.body);
    expect(body.data.name).toBe(TASK.title);
    expect(body.data.projects).toEqual(['proj-7']);
    expect(body.data.notes).toContain('View in Pinpoint');
  });

  it('surfaces Asana errors on failure', async () => {
    const safeFetch = vi.fn(async () =>
      errJson(403, { errors: [{ message: 'Not authorized' }] }),
    ) as any;
    const provider = createAsanaProvider({ safeFetch });
    await expect(
      provider.createTask({ accessToken: 't', config: { projectGid: 'g' } }, TASK),
    ).rejects.toMatchObject({ transient: false, status: 403 });
  });
});

describe('error sanitization', () => {
  it('never includes the access token in a mapped error message', async () => {
    const token = 'super-secret-token-value';
    const safeFetch = vi.fn(async () => errJson(400, { message: 'bad request' })) as any;
    const provider = createGithubProvider({ safeFetch });
    try {
      await provider.createTask({ accessToken: token, config: { owner: 'a', repo: 'b' } }, TASK);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as Error).message).not.toContain(token);
    }
  });
});
