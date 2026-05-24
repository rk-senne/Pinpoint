// dashboard/src/components/TeamManagement.ts
//
// Vanilla-TS port of the team-management UI (task 18.10, Requirement 9.1–9.5,
// design page "Team Management"). Replaces the prior `TeamsTab` React subtree
// embedded in `SettingsPage.tsx`.
//
// UI conventions follow `dashboard/src/lib/render.ts`:
//   - Markup lives in `<template>` blocks in `index.html`
//     (`tpl-team-management`, `tpl-team-management-team`,
//     `tpl-team-management-member`).
//   - DOM is materialised via `cloneTemplate` + `mount`.
//   - Top-level event wiring (create-team form, invite forms, role <select>,
//     and remove buttons) goes through `bindEvents`.
//   - Reactive state lives in `teamsStore` and the auth store from
//     `dashboard/src/lib/stores.ts`.
//
// Behaviour preserved from the React TeamsTab:
//   - List teams the user belongs to (Req 9.1, displayed via the create flow).
//   - Create a new team via `POST /api/v1/teams` (Req 9.1).
//   - View team members joined with their email/name and current role.
//   - Invite a member by email via `POST /api/v1/teams/:id/invite`
//     (Req 9.2). Restricted to owners and admins.
//   - Change a member's role via `PUT /api/v1/teams/:id/members/:userId`
//     (Req 9.3). Restricted to owners and admins; you cannot change your own
//     role.
//   - Remove a member via `DELETE /api/v1/teams/:id/members/:userId`
//     (Req 9.5). Restricted to owners; you cannot remove yourself.
//
// The module exposes `mountTeamManagement(host, deps)` returning a handle so
// tests (and the eventual settings/teams route) can mount, refresh, and
// dispose without touching globals.

import type { TeamRole } from '@pinpoint/shared';

import { apiFetch as defaultApiFetch, fetchCurrentUser } from '../lib/api';
import {
  attr,
  bind,
  bindEvents,
  cloneTemplate,
  mount,
} from '../lib/render';
import {
  authStore,
  setTeams,
  teamsStore,
  type TeamMemberSummary,
  type TeamWithMembers,
} from '../lib/stores';

// --- Public API -------------------------------------------------------

export interface TeamManagementDeps {
  /** Fetch shim — defaults to the production `apiFetch`. Tests inject fakes. */
  apiFetch?: typeof defaultApiFetch;
  /** Confirm dialog — defaults to `window.confirm`. Tests inject fakes. */
  confirm?: (message: string) => boolean;
}

export interface TeamManagementHandle {
  /** Tear down DOM listeners and store subscriptions. */
  dispose(): void;
  /** Re-pull the current user and team list from the API. */
  refresh(): Promise<void>;
}

interface TeamsResponse {
  teams: TeamWithMembers[];
}

// --- Implementation ---------------------------------------------------

const ROLE_BADGE_COLORS: Record<TeamRole, { bg: string; fg: string }> = {
  owner: { bg: '#fef3c7', fg: '#92400e' },
  admin: { bg: '#dbeafe', fg: '#1e40af' },
  viewer: { bg: '#f3f4f6', fg: '#374151' },
};

const ROLE_OPTIONS: TeamRole[] = ['owner', 'admin', 'viewer'];

function paintRoleBadge(el: HTMLElement, role: TeamRole): void {
  const colors = ROLE_BADGE_COLORS[role] ?? ROLE_BADGE_COLORS.viewer;
  el.style.background = colors.bg;
  el.style.color = colors.fg;
}

/**
 * Mount the team-management UI into `host`. Returns a handle whose
 * `dispose()` removes every subscription and listener registered by this
 * call so callers can re-render or unmount safely.
 */
export function mountTeamManagement(
  host: HTMLElement,
  deps: TeamManagementDeps = {},
): TeamManagementHandle {
  const apiFetch = deps.apiFetch ?? defaultApiFetch;
  const confirmFn = deps.confirm ?? ((m: string) => window.confirm(m));

  // ---------- DOM scaffolding ----------------------------------------
  const fragment = cloneTemplate('tpl-team-management');
  const root = fragment.firstElementChild as HTMLElement;
  mount(host, fragment);

  const errorEl = root.querySelector<HTMLElement>('[data-role="error"]')!;
  const loadingEl = root.querySelector<HTMLElement>('[data-role="loading"]')!;
  const contentEl = root.querySelector<HTMLElement>('[data-role="content"]')!;
  const emptyEl = root.querySelector<HTMLElement>('[data-role="empty"]')!;
  const listEl = root.querySelector<HTMLElement>('[data-role="list"]')!;
  const newTeamInput = root.querySelector<HTMLInputElement>(
    '[data-role="new-team-name"]',
  )!;
  const createSubmitBtn = root.querySelector<HTMLButtonElement>(
    '[data-role="create-submit"]',
  )!;

  let creatingTeam = false;
  // Tracks per-team invite-in-flight state. Disables the invite button while
  // the request is open without re-rendering the entire team card.
  const inviting = new Map<string, boolean>();

  const cleanups: Array<() => void> = [];
  // Per-team listener cleanups; cleared on every rerender so detached cards
  // can be GC'd.
  let teamCleanups: Array<() => void> = [];

  // ---------- Top-level event wiring ---------------------------------
  cleanups.push(
    bindEvents(root, {
      createTeam: (e) => {
        e.preventDefault();
        void handleCreateTeam();
      },
    }),
  );

  // ---------- Reactive bindings --------------------------------------
  cleanups.push(
    bind(listEl, teamsStore.list, () => rerenderList()),
    bind(listEl, authStore.currentUser, () => rerenderList()),
  );

  // ---------- Error and loading helpers ------------------------------
  function showError(message: string): void {
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  function clearError(): void {
    errorEl.textContent = '';
    errorEl.hidden = true;
  }

  function setLoading(loading: boolean): void {
    loadingEl.hidden = !loading;
    contentEl.hidden = loading;
  }

  function setCreatingTeam(value: boolean): void {
    creatingTeam = value;
    createSubmitBtn.disabled = value;
    createSubmitBtn.textContent = value ? 'Creating…' : 'Create Team';
    createSubmitBtn.style.cursor = value ? 'not-allowed' : 'pointer';
  }

  // ---------- Permission helpers -------------------------------------
  function getMyRole(team: TeamWithMembers): TeamRole {
    const myId = authStore.currentUser.get()?.id ?? null;
    if (myId === null) return team.role;
    const me = team.members.find((m) => m.userId === myId);
    return me?.role ?? team.role;
  }

  function canManageMembers(team: TeamWithMembers): boolean {
    const role = getMyRole(team);
    return role === 'owner' || role === 'admin';
  }

  // ---------- Rendering ----------------------------------------------
  function rerenderList(): void {
    // Tear down listeners attached to the previous batch of cards before
    // we detach them from the DOM.
    for (const cleanup of teamCleanups) cleanup();
    teamCleanups = [];

    listEl.replaceChildren();
    const teams = teamsStore.list.get();
    if (teams.length === 0) {
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;

    for (const team of teams) {
      listEl.appendChild(renderTeam(team));
    }
  }

  function renderTeam(team: TeamWithMembers): HTMLElement {
    const myRole = getMyRole(team);
    const fragment = cloneTemplate('tpl-team-management-team', {
      'team-name': team.name,
      'my-role-label': myRole,
    });
    const card = fragment.firstElementChild as HTMLElement;
    attr(card, 'data-team-id', team.id);

    paintRoleBadge(card.querySelector<HTMLElement>('[data-role="my-role"]')!, myRole);

    const membersEl = card.querySelector<HTMLElement>('[data-role="members"]')!;
    for (const member of team.members) {
      membersEl.appendChild(renderMember(team, member));
    }

    // Wire role <select> change and remove buttons via event delegation on
    // the card so the per-member templates stay declarative.
    const cardCleanup = bindEvents(card, {
      remove: (e) => {
        const userId = (e.currentTarget as HTMLElement).getAttribute(
          'data-user-id',
        );
        if (!userId) return;
        void handleRemoveMember(team, userId);
      },
      invite: (e) => {
        e.preventDefault();
        void handleInvite(team);
      },
    });
    teamCleanups.push(cardCleanup);

    // The role <select>'s `change` event is not covered by `bindEvents`
    // because each select belongs to a member row inside this card, not the
    // card itself.
    const onRoleChange = (e: Event): void => {
      const select = e.target as HTMLSelectElement;
      if (!select.matches('[data-role="role-select"]')) return;
      const userId = select.getAttribute('data-user-id');
      if (!userId) return;
      const newRole = select.value as TeamRole;
      void handleRoleChange(team, userId, newRole, select);
    };
    card.addEventListener('change', onRoleChange);
    teamCleanups.push(() => card.removeEventListener('change', onRoleChange));

    // Show the invite form for members with management permission.
    const inviteForm = card.querySelector<HTMLFormElement>(
      '[data-role="invite"]',
    )!;
    if (canManageMembers(team)) {
      inviteForm.hidden = false;
      const inviteSubmit = inviteForm.querySelector<HTMLButtonElement>(
        '[data-role="invite-submit"]',
      )!;
      const isInviting = inviting.get(team.id) === true;
      inviteSubmit.disabled = isInviting;
      inviteSubmit.textContent = isInviting ? 'Inviting…' : 'Invite';
    }

    return card;
  }

  function renderMember(
    team: TeamWithMembers,
    member: TeamMemberSummary,
  ): HTMLElement {
    const displayName = member.name || member.email || member.userId;
    const fragment = cloneTemplate('tpl-team-management-member', {
      'display-name': displayName,
      email: member.name && member.email ? member.email : '',
      'role-label': member.role,
    });
    const row = fragment.firstElementChild as HTMLElement;
    attr(row, 'data-user-id', member.userId);

    // Hide the email span when there's no separate name to show, matching
    // the React layout that only rendered the email when both fields were
    // available.
    const emailEl = row.querySelector<HTMLElement>('[data-role="email"]')!;
    if (!(member.name && member.email)) {
      emailEl.hidden = true;
    }

    paintRoleBadge(
      row.querySelector<HTMLElement>('[data-role="role-badge"]')!,
      member.role,
    );

    const myId = authStore.currentUser.get()?.id ?? null;
    const myRole = getMyRole(team);
    const isSelf = myId !== null && member.userId === myId;
    const canManage = canManageMembers(team) && !isSelf;

    const select = row.querySelector<HTMLSelectElement>(
      '[data-role="role-select"]',
    )!;
    const removeBtn = row.querySelector<HTMLButtonElement>(
      '[data-role="remove"]',
    )!;

    if (canManage) {
      select.hidden = false;
      attr(select, 'data-user-id', member.userId);
      // Mark options. We can't reuse the `option.value=member.role` shorthand
      // alone because jsdom's setter accepts arbitrary strings and we want
      // typescript-friendly enumeration.
      for (const option of Array.from(select.options)) {
        option.selected = option.value === member.role;
      }
    }

    if (myRole === 'owner' && !isSelf) {
      removeBtn.hidden = false;
      attr(removeBtn, 'data-user-id', member.userId);
    }

    return row;
  }

  // ---------- Handlers -----------------------------------------------
  async function handleCreateTeam(): Promise<void> {
    if (creatingTeam) return;
    const name = newTeamInput.value.trim();
    if (!name) return;
    setCreatingTeam(true);
    clearError();
    try {
      await apiFetch('/teams', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      newTeamInput.value = '';
      await refresh();
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Failed to create team.');
    } finally {
      setCreatingTeam(false);
    }
  }

  async function handleInvite(team: TeamWithMembers): Promise<void> {
    const card = listEl.querySelector<HTMLElement>(
      `[data-team-id="${cssEscapeAttr(team.id)}"]`,
    );
    if (!card) return;
    const inviteInput = card.querySelector<HTMLInputElement>(
      '[data-role="invite-email"]',
    )!;
    const email = inviteInput.value.trim();
    if (!email) return;
    if (inviting.get(team.id)) return;
    inviting.set(team.id, true);
    rerenderList();
    clearError();
    try {
      await apiFetch(`/teams/${team.id}/invite`, {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
      // Successful invites clear the input, but `rerenderList` rebuilds the
      // DOM so the next render must start from a clean state.
      await refresh();
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Failed to invite member.');
    } finally {
      inviting.set(team.id, false);
      rerenderList();
    }
  }

  async function handleRoleChange(
    team: TeamWithMembers,
    userId: string,
    newRole: TeamRole,
    select: HTMLSelectElement,
  ): Promise<void> {
    if (!ROLE_OPTIONS.includes(newRole)) return;
    clearError();
    try {
      await apiFetch(`/teams/${team.id}/members/${userId}`, {
        method: 'PUT',
        body: JSON.stringify({ role: newRole }),
      });
      await refresh();
    } catch (err) {
      // Roll the <select> back to the previously selected role so the UI
      // stays in sync with the unchanged server state.
      const prevMember = team.members.find((m) => m.userId === userId);
      if (prevMember) {
        select.value = prevMember.role;
      }
      showError(err instanceof Error ? err.message : 'Failed to change role.');
    }
  }

  async function handleRemoveMember(
    team: TeamWithMembers,
    userId: string,
  ): Promise<void> {
    if (!confirmFn('Remove this member from the team?')) return;
    clearError();
    try {
      await apiFetch(`/teams/${team.id}/members/${userId}`, {
        method: 'DELETE',
      });
      await refresh();
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Failed to remove member.');
    }
  }

  // ---------- Data fetch ---------------------------------------------
  async function refresh(): Promise<void> {
    setLoading(true);
    clearError();
    try {
      const [user, teamsResponse] = await Promise.all([
        // Route through the shared `fetchCurrentUser` helper for the
        // response-shape normalisation; passes the injected fake fetch
        // through so tests still observe the call.
        fetchCurrentUser(apiFetch),
        apiFetch<TeamsResponse | TeamWithMembers[]>('/teams'),
      ]);
      // The server wraps `teams`, but historic builds returned the bare
      // value. Normalise both shapes so the component is resilient to
      // either contract.
      const teams =
        (teamsResponse as TeamsResponse).teams ??
        (teamsResponse as TeamWithMembers[]);

      authStore.currentUser.set(user);
      authStore.isAuthenticated.set(true);
      setTeams(teams);
    } catch (err) {
      showError(
        err instanceof Error ? err.message : 'Failed to load teams.',
      );
    } finally {
      setLoading(false);
    }
  }

  // Kick off the initial fetch. The promise is intentionally not awaited so
  // mount returns synchronously.
  void refresh();

  // ---------- Lifecycle ----------------------------------------------
  function dispose(): void {
    for (const cleanup of cleanups) cleanup();
    cleanups.length = 0;
    for (const cleanup of teamCleanups) cleanup();
    teamCleanups = [];
    inviting.clear();
    root.remove();
  }

  return { dispose, refresh };
}

// ---------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------

function cssEscapeAttr(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, '\\$&');
}
