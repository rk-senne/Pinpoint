// @vitest-environment jsdom
//
// Unit tests for the vanilla-TS `TeamManagement` component (task 18.10).
//
// The component reads its <template> blocks from `index.html`. The tests
// register the same templates dynamically so this file is independent of the
// production shell. Each test injects a fake `apiFetch` so we never touch the
// network and assert behaviour against the DOM and the teams store.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { mountTeamManagement } from './TeamManagement';
import {
  authStore,
  resetStores,
  teamsStore,
  type TeamWithMembers,
} from '../lib/stores';

// ---- Template fixtures ----------------------------------------------
//
// We mirror only the structure the component reads from `index.html`. The
// inline styles from the production shell are dropped — `data-role` /
// `data-action` / `data-slot` attributes are the public API.

const TEMPLATES: Record<string, string> = {
  'tpl-team-management': `
    <div data-role="root">
      <p data-role="error" hidden></p>
      <p data-role="loading">Loading…</p>
      <section data-role="content" hidden>
        <form data-action="submit:createTeam" data-role="create-form">
          <input data-role="new-team-name" type="text" />
          <button type="submit" data-role="create-submit">Create Team</button>
        </form>
        <p data-role="empty" hidden>No teams yet.</p>
        <div data-role="list"></div>
      </section>
    </div>
  `,
  'tpl-team-management-team': `
    <article data-role="team">
      <header>
        <h3 data-slot="team-name"></h3>
        <span data-role="my-role" data-slot="my-role-label"></span>
      </header>
      <div data-role="members"></div>
      <form data-role="invite" data-action="submit:invite" hidden>
        <input data-role="invite-email" type="email" />
        <button type="submit" data-role="invite-submit">Invite</button>
      </form>
    </article>
  `,
  'tpl-team-management-member': `
    <div data-role="member">
      <div>
        <span data-slot="display-name"></span>
        <span data-role="email" data-slot="email"></span>
      </div>
      <div>
        <span data-role="role-badge" data-slot="role-label"></span>
        <select data-role="role-select" hidden>
          <option value="owner">Owner</option>
          <option value="admin">Admin</option>
          <option value="viewer">Viewer</option>
        </select>
        <button type="button" data-role="remove" data-action="remove" hidden>
          Remove
        </button>
      </div>
    </div>
  `,
};

function installTemplates(): void {
  for (const [id, html] of Object.entries(TEMPLATES)) {
    const tpl = document.createElement('template');
    tpl.id = id;
    tpl.innerHTML = html;
    document.body.appendChild(tpl);
  }
}

// ---- Fixtures --------------------------------------------------------

const ME_ID = 'user-me';

function makeTeam(overrides: Partial<TeamWithMembers> = {}): TeamWithMembers {
  return {
    id: overrides.id ?? 't1',
    name: overrides.name ?? 'Alpha',
    ownerId: overrides.ownerId ?? ME_ID,
    createdAt: overrides.createdAt ?? '2024-01-01T00:00:00.000Z',
    role: overrides.role ?? 'owner',
    members: overrides.members ?? [
      { userId: ME_ID, role: 'owner', email: 'me@test.com', name: 'Me' },
    ],
  };
}

interface FakeApi {
  /** All recorded calls in order. */
  calls: Array<{ path: string; init?: RequestInit }>;
  /** Convenience accessor for the last call. */
  last: () => { path: string; init?: RequestInit } | undefined;
  fetch: <T>(path: string, init?: RequestInit) => Promise<T>;
}

function makeFakeApi(
  responses: Record<string, unknown | ((init?: RequestInit) => unknown)> = {},
): FakeApi {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  return {
    calls,
    last: () => calls[calls.length - 1],
    fetch: async <T,>(path: string, init?: RequestInit): Promise<T> => {
      calls.push({ path, init });
      const method = init?.method ?? 'GET';
      const key = `${method} ${path}`;
      if (key in responses) {
        const value = responses[key];
        const out =
          typeof value === 'function'
            ? (value as (i?: RequestInit) => unknown)(init)
            : value;
        return out as T;
      }
      if (path in responses) {
        const value = responses[path];
        const out =
          typeof value === 'function'
            ? (value as (i?: RequestInit) => unknown)(init)
            : value;
        return out as T;
      }
      // Default: treat unknown calls as successful no-ops.
      return undefined as T;
    },
  };
}

// `mountTeamManagement` calls `/users/me` and `/teams` in parallel on mount.
// Allow several microtask flushes so the chained promises settle.
async function flushAsync(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

let host: HTMLDivElement;

beforeEach(() => {
  installTemplates();
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  resetStores();
  document.body.innerHTML = '';
});

// ---- Tests -----------------------------------------------------------

describe('mountTeamManagement — initial render', () => {
  it('fetches `/users/me` and `/teams` on mount and populates the team list', async () => {
    const team = makeTeam({ name: 'Alpha Team' });
    const api = makeFakeApi({
      '/users/me': { user: { id: ME_ID, email: 'me@test.com', name: 'Me' } },
      '/teams': { teams: [team] },
    });

    const handle = mountTeamManagement(host, { apiFetch: api.fetch });
    await flushAsync();

    const paths = api.calls.map((c) => c.path);
    expect(paths).toContain('/users/me');
    expect(paths).toContain('/teams');

    expect(host.querySelector('[data-role="content"]')!.hasAttribute('hidden')).toBe(
      false,
    );
    expect(host.querySelector('[data-slot="team-name"]')!.textContent).toBe(
      'Alpha Team',
    );
    expect(authStore.currentUser.get()?.id).toBe(ME_ID);
    expect(teamsStore.list.get()).toHaveLength(1);

    handle.dispose();
  });

  it('renders an empty-state message when the user has no teams', async () => {
    const api = makeFakeApi({
      '/users/me': { user: { id: ME_ID, email: 'me@test.com', name: 'Me' } },
      '/teams': { teams: [] },
    });

    const handle = mountTeamManagement(host, { apiFetch: api.fetch });
    await flushAsync();

    const empty = host.querySelector<HTMLElement>('[data-role="empty"]')!;
    expect(empty.hidden).toBe(false);
    expect(host.querySelectorAll('[data-role="team"]')).toHaveLength(0);

    handle.dispose();
  });

  it('shows an error message when the fetch fails', async () => {
    const api: FakeApi = {
      calls: [],
      last: () => undefined,
      fetch: async () => {
        throw new Error('boom');
      },
    };

    const handle = mountTeamManagement(host, { apiFetch: api.fetch });
    await flushAsync();

    const errorEl = host.querySelector<HTMLElement>('[data-role="error"]')!;
    expect(errorEl.hidden).toBe(false);
    expect(errorEl.textContent).toContain('boom');

    handle.dispose();
  });
});

describe('create team (Req 9.1)', () => {
  it('POSTs the trimmed name and refreshes', async () => {
    const initial = makeTeam({ id: 't1', name: 'Alpha' });
    const next = makeTeam({ id: 't2', name: 'Beta' });
    const teams = [initial];
    const api = makeFakeApi({
      '/users/me': { user: { id: ME_ID, email: 'me@test.com', name: 'Me' } },
      'GET /teams': () => ({ teams: [...teams] }),
      'POST /teams': () => {
        teams.push(next);
        return { team: { id: next.id, name: next.name, ownerId: ME_ID } };
      },
    });

    const handle = mountTeamManagement(host, { apiFetch: api.fetch });
    await flushAsync();

    const input = host.querySelector<HTMLInputElement>('[data-role="new-team-name"]')!;
    input.value = '  Beta  ';

    host
      .querySelector<HTMLFormElement>('[data-role="create-form"]')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await flushAsync();

    const post = api.calls.find((c) => c.init?.method === 'POST');
    expect(post?.path).toBe('/teams');
    expect(JSON.parse((post?.init?.body as string) ?? '{}')).toEqual({
      name: 'Beta',
    });

    // Two team cards now visible.
    const names = Array.from(
      host.querySelectorAll('[data-slot="team-name"]'),
    ).map((n) => n.textContent);
    expect(names).toEqual(['Alpha', 'Beta']);

    handle.dispose();
  });

  it('does not POST when the new-team input is empty or whitespace', async () => {
    const api = makeFakeApi({
      '/users/me': { user: { id: ME_ID, email: 'me@test.com', name: 'Me' } },
      '/teams': { teams: [] },
    });

    const handle = mountTeamManagement(host, { apiFetch: api.fetch });
    await flushAsync();

    const input = host.querySelector<HTMLInputElement>('[data-role="new-team-name"]')!;
    input.value = '   ';

    host
      .querySelector<HTMLFormElement>('[data-role="create-form"]')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await flushAsync();
    expect(api.calls.some((c) => c.init?.method === 'POST')).toBe(false);

    handle.dispose();
  });
});

describe('member management', () => {
  it('shows the invite form for owners (Req 9.2)', async () => {
    const team = makeTeam({ role: 'owner' });
    const api = makeFakeApi({
      '/users/me': { user: { id: ME_ID, email: 'me@test.com', name: 'Me' } },
      '/teams': { teams: [team] },
    });

    const handle = mountTeamManagement(host, { apiFetch: api.fetch });
    await flushAsync();

    const invite = host.querySelector<HTMLFormElement>('[data-role="invite"]')!;
    expect(invite.hidden).toBe(false);

    handle.dispose();
  });

  it('hides the invite form for viewers', async () => {
    const team = makeTeam({
      role: 'viewer',
      members: [
        { userId: ME_ID, role: 'viewer', email: 'me@test.com', name: 'Me' },
      ],
    });
    const api = makeFakeApi({
      '/users/me': { user: { id: ME_ID, email: 'me@test.com', name: 'Me' } },
      '/teams': { teams: [team] },
    });

    const handle = mountTeamManagement(host, { apiFetch: api.fetch });
    await flushAsync();

    const invite = host.querySelector<HTMLFormElement>('[data-role="invite"]')!;
    expect(invite.hidden).toBe(true);

    handle.dispose();
  });

  it('POSTs to /teams/:id/invite when an owner submits an email (Req 9.2)', async () => {
    const team = makeTeam({ id: 't1', role: 'owner' });
    const teamWithInvitee = makeTeam({
      id: 't1',
      role: 'owner',
      members: [
        ...team.members,
        {
          userId: 'invitee',
          role: 'viewer',
          email: 'invitee@test.com',
          name: 'Invitee',
        },
      ],
    });
    let response: TeamWithMembers[] = [team];
    const api = makeFakeApi({
      '/users/me': { user: { id: ME_ID, email: 'me@test.com', name: 'Me' } },
      'GET /teams': () => ({ teams: response }),
      'POST /teams/t1/invite': () => {
        response = [teamWithInvitee];
        return undefined;
      },
    });

    const handle = mountTeamManagement(host, { apiFetch: api.fetch });
    await flushAsync();

    const inviteInput = host.querySelector<HTMLInputElement>(
      '[data-role="invite-email"]',
    )!;
    inviteInput.value = 'invitee@test.com';

    host
      .querySelector<HTMLFormElement>('[data-role="invite"]')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await flushAsync();

    const post = api.calls.find((c) => c.init?.method === 'POST');
    expect(post?.path).toBe('/teams/t1/invite');
    expect(JSON.parse((post?.init?.body as string) ?? '{}')).toEqual({
      email: 'invitee@test.com',
    });

    // Member row appears.
    const names = Array.from(
      host.querySelectorAll('[data-role="members"] [data-slot="display-name"]'),
    ).map((n) => n.textContent);
    expect(names).toContain('Invitee');

    handle.dispose();
  });

  it('PUTs the new role and refreshes when an owner changes a member role (Req 9.3)', async () => {
    const member = {
      userId: 'u2',
      role: 'viewer' as const,
      email: 'u2@test.com',
      name: 'Other',
    };
    const team = makeTeam({
      id: 't1',
      role: 'owner',
      members: [
        { userId: ME_ID, role: 'owner', email: 'me@test.com', name: 'Me' },
        member,
      ],
    });
    const api = makeFakeApi({
      '/users/me': { user: { id: ME_ID, email: 'me@test.com', name: 'Me' } },
      'GET /teams': { teams: [team] },
      'PUT /teams/t1/members/u2': undefined,
    });

    const handle = mountTeamManagement(host, { apiFetch: api.fetch });
    await flushAsync();

    const select = host.querySelector<HTMLSelectElement>(
      '[data-role="member"][data-user-id="u2"] [data-role="role-select"]',
    )!;
    expect(select.hidden).toBe(false);
    select.value = 'admin';
    select.dispatchEvent(new Event('change', { bubbles: true }));

    await flushAsync();

    const put = api.calls.find((c) => c.init?.method === 'PUT');
    expect(put?.path).toBe('/teams/t1/members/u2');
    expect(JSON.parse((put?.init?.body as string) ?? '{}')).toEqual({
      role: 'admin',
    });

    handle.dispose();
  });

  it('hides role <select> on the current user’s own row', async () => {
    const team = makeTeam({
      role: 'owner',
      members: [
        { userId: ME_ID, role: 'owner', email: 'me@test.com', name: 'Me' },
        { userId: 'u2', role: 'viewer', email: 'u2@test.com', name: 'Other' },
      ],
    });
    const api = makeFakeApi({
      '/users/me': { user: { id: ME_ID, email: 'me@test.com', name: 'Me' } },
      '/teams': { teams: [team] },
    });

    const handle = mountTeamManagement(host, { apiFetch: api.fetch });
    await flushAsync();

    const myRow = host.querySelector<HTMLElement>(
      `[data-role="member"][data-user-id="${ME_ID}"]`,
    )!;
    const otherRow = host.querySelector<HTMLElement>(
      '[data-role="member"][data-user-id="u2"]',
    )!;
    expect(myRow.querySelector<HTMLSelectElement>('[data-role="role-select"]')!.hidden).toBe(
      true,
    );
    expect(
      otherRow.querySelector<HTMLSelectElement>('[data-role="role-select"]')!.hidden,
    ).toBe(false);

    handle.dispose();
  });

  it('DELETEs after confirmation when an owner removes a member (Req 9.5)', async () => {
    const team = makeTeam({
      id: 't1',
      role: 'owner',
      members: [
        { userId: ME_ID, role: 'owner', email: 'me@test.com', name: 'Me' },
        { userId: 'u2', role: 'viewer', email: 'u2@test.com', name: 'Other' },
      ],
    });
    let response: TeamWithMembers[] = [team];
    const api = makeFakeApi({
      '/users/me': { user: { id: ME_ID, email: 'me@test.com', name: 'Me' } },
      'GET /teams': () => ({ teams: response }),
      'DELETE /teams/t1/members/u2': () => {
        response = [
          {
            ...team,
            members: team.members.filter((m) => m.userId !== 'u2'),
          },
        ];
        return undefined;
      },
    });
    const confirmFn = vi.fn().mockReturnValue(true);

    const handle = mountTeamManagement(host, {
      apiFetch: api.fetch,
      confirm: confirmFn,
    });
    await flushAsync();

    const removeBtn = host.querySelector<HTMLButtonElement>(
      '[data-role="member"][data-user-id="u2"] [data-role="remove"]',
    )!;
    expect(removeBtn.hidden).toBe(false);
    removeBtn.click();

    await flushAsync();

    expect(confirmFn).toHaveBeenCalledOnce();
    const del = api.calls.find((c) => c.init?.method === 'DELETE');
    expect(del?.path).toBe('/teams/t1/members/u2');

    // Other member is gone after refresh.
    expect(
      host.querySelector('[data-role="member"][data-user-id="u2"]'),
    ).toBeNull();

    handle.dispose();
  });

  it('does not call DELETE when the confirm dialog is cancelled', async () => {
    const team = makeTeam({
      id: 't1',
      role: 'owner',
      members: [
        { userId: ME_ID, role: 'owner', email: 'me@test.com', name: 'Me' },
        { userId: 'u2', role: 'viewer', email: 'u2@test.com', name: 'Other' },
      ],
    });
    const api = makeFakeApi({
      '/users/me': { user: { id: ME_ID, email: 'me@test.com', name: 'Me' } },
      '/teams': { teams: [team] },
    });

    const handle = mountTeamManagement(host, {
      apiFetch: api.fetch,
      confirm: () => false,
    });
    await flushAsync();

    host
      .querySelector<HTMLButtonElement>(
        '[data-role="member"][data-user-id="u2"] [data-role="remove"]',
      )!
      .click();
    await flushAsync();

    expect(api.calls.some((c) => c.init?.method === 'DELETE')).toBe(false);

    handle.dispose();
  });

  it('hides the Remove button for non-owners', async () => {
    const team = makeTeam({
      role: 'admin',
      members: [
        { userId: ME_ID, role: 'admin', email: 'me@test.com', name: 'Me' },
        { userId: 'u2', role: 'viewer', email: 'u2@test.com', name: 'Other' },
      ],
    });
    const api = makeFakeApi({
      '/users/me': { user: { id: ME_ID, email: 'me@test.com', name: 'Me' } },
      '/teams': { teams: [team] },
    });

    const handle = mountTeamManagement(host, { apiFetch: api.fetch });
    await flushAsync();

    const removeBtn = host.querySelector<HTMLButtonElement>(
      '[data-role="member"][data-user-id="u2"] [data-role="remove"]',
    )!;
    expect(removeBtn.hidden).toBe(true);

    handle.dispose();
  });
});

describe('dispose', () => {
  it('removes DOM and ignores subsequent store updates', async () => {
    const team = makeTeam();
    const api = makeFakeApi({
      '/users/me': { user: { id: ME_ID, email: 'me@test.com', name: 'Me' } },
      '/teams': { teams: [team] },
    });

    const handle = mountTeamManagement(host, { apiFetch: api.fetch });
    await flushAsync();

    handle.dispose();
    expect(host.children).toHaveLength(0);

    // Triggering a store change after dispose must not re-render anything.
    teamsStore.list.set([makeTeam({ id: 't2', name: 'Beta' })]);
    expect(host.querySelectorAll('[data-role="team"]')).toHaveLength(0);
  });
});
