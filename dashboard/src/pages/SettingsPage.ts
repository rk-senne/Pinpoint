/**
 * SettingsPage — vanilla TypeScript (Requirement 31.1, task 18.9).
 *
 * Replaces `SettingsPage.tsx` with a no-React module that mounts the shared
 * AppLayout shell and renders the three-tab settings surface (Profile,
 * Notifications, Guidelines) inside the layout's content slot.
 *
 * Behaviour preserved from the React version:
 *   - **Profile tab** — fetches the current user from `GET /users/me`,
 *     binds the name/email/avatar inputs, and PUTs the updated profile to
 *     `PUT /users/me`.
 *   - **Notifications tab** — fetches the user's notification preferences
 *     from `GET /users/me`, renders one toggle per preference key, and
 *     PUTs the updated preferences to `PUT /users/me/notifications`.
 *     Optimistically updates the UI; reverts on failure.
 *   - **Guidelines tab** — fetches `GET /guidelines`, lists them with a
 *     "Default" badge for Nielsen's heuristics, and POSTs new custom
 *     guidelines to `POST /guidelines`.
 *
 * Each tab fetches lazily on first activation so the user only pays for the
 * data they look at. Re-activating a tab does not re-fetch — the page caches
 * each panel's fetched state for the lifetime of the mount.
 *
 * The exported `mountSettingsPage` matches the `RouteHandler` shape from
 * `lib/router.ts` so it can be registered with
 * `defineRoute('/settings', mountSettingsPage)`.
 *
 * Requirements: 31.1
 */

import type { Guideline, NotificationPreferences, User } from '@pinpoint/shared';

import { mountAppLayout } from '../components/AppLayout';
import { mountTeamManagement, type TeamManagementHandle } from '../components/TeamManagement';
import { apiFetch as defaultApiFetch, fetchCurrentUser } from '../lib/api';
import {
  attr,
  bindEvents,
  cloneTemplate,
  requireRole,
  requireSection,
  text,
} from '../lib/render';

type SettingsTab = 'profile' | 'notifications' | 'guidelines' | 'teams';

interface NotificationRow {
  key: keyof NotificationPreferences;
  label: string;
}

const NOTIFICATION_ROWS: NotificationRow[] = [
  { key: 'newAnnotation', label: 'New annotation created on my project' },
  { key: 'newComment', label: 'New comment added' },
  { key: 'promotedToOwner', label: 'Got promoted to project owner' },
  { key: 'projectDeleted', label: 'Project deleted by owner' },
];

export interface MountSettingsPageOptions {
  /** Fetch shim — defaults to the production `apiFetch`. Tests inject fakes. */
  apiFetch?: typeof defaultApiFetch;
}

/**
 * Mount the settings page into `rootEl`. The optional `params` argument is
 * accepted (and ignored) so the function is directly assignable to the
 * `RouteHandler` type exported by `lib/router.ts`.
 *
 * Returns a teardown function that detaches every event listener and
 * removes the page DOM and the layout shell.
 */
export function mountSettingsPage(
  rootEl: HTMLElement,
  _params?: Record<string, string>,
  options: MountSettingsPageOptions = {},
): () => void {
  const apiFetch = options.apiFetch ?? defaultApiFetch;

  // ---- Page DOM ---------------------------------------------------------
  const fragment = cloneTemplate('tpl-settings-page');
  const contentRoot = fragment.firstElementChild as HTMLElement | null;
  if (!contentRoot) {
    throw new Error('mountSettingsPage: #tpl-settings-page template is empty');
  }

  // Tab buttons + sections.
  const tabButtons: Record<SettingsTab, HTMLButtonElement> = {
    profile: requireRole(contentRoot, 'tab-profile') as HTMLButtonElement,
    notifications: requireRole(
      contentRoot,
      'tab-notifications',
    ) as HTMLButtonElement,
    guidelines: requireRole(contentRoot, 'tab-guidelines') as HTMLButtonElement,
    teams: requireRole(contentRoot, 'tab-teams') as HTMLButtonElement,
  };
  const tabSections: Record<SettingsTab, HTMLElement> = {
    profile: requireSection(contentRoot, 'profile'),
    notifications: requireSection(contentRoot, 'notifications'),
    guidelines: requireSection(contentRoot, 'guidelines'),
    teams: requireSection(contentRoot, 'teams'),
  };
  const teamsContainer = requireRole(contentRoot, 'teams-container');

  // Profile refs.
  const profileLoading = requireRole(contentRoot, 'profile-loading');
  const profileForm = requireRole(contentRoot, 'profile-form') as HTMLFormElement;
  const profileNameInput = requireRole(
    contentRoot,
    'profile-name',
  ) as HTMLInputElement;
  const profileEmailInput = requireRole(
    contentRoot,
    'profile-email',
  ) as HTMLInputElement;
  const profileAvatarInput = requireRole(
    contentRoot,
    'profile-avatar',
  ) as HTMLInputElement;
  const profileMessage = requireRole(contentRoot, 'profile-message');
  const profileSubmit = requireRole(
    contentRoot,
    'profile-submit',
  ) as HTMLButtonElement;

  // Notifications refs.
  const notificationsLoading = requireRole(contentRoot, 'notifications-loading');
  const notificationsError = requireRole(contentRoot, 'notifications-error');
  const notificationsContent = requireRole(contentRoot, 'notifications-content');
  const notificationsList = requireRole(contentRoot, 'notifications-list');

  // Guidelines refs.
  const guidelinesLoading = requireRole(contentRoot, 'guidelines-loading');
  const guidelinesError = requireRole(contentRoot, 'guidelines-error');
  const guidelinesContent = requireRole(contentRoot, 'guidelines-content');
  const guidelinesEmpty = requireRole(contentRoot, 'guidelines-empty');
  const guidelinesList = requireRole(contentRoot, 'guidelines-list');
  const guidelineForm = requireRole(contentRoot, 'guideline-form') as HTMLFormElement;
  const guidelineNameInput = requireRole(
    contentRoot,
    'guideline-name',
  ) as HTMLInputElement;
  const guidelineDescInput = requireRole(
    contentRoot,
    'guideline-desc',
  ) as HTMLTextAreaElement;
  const guidelineSubmit = requireRole(
    contentRoot,
    'guideline-submit',
  ) as HTMLButtonElement;

  // ---- Local mutable state ---------------------------------------------
  let activeTab: SettingsTab = 'profile';

  // Profile state.
  let profileLoaded = false;
  let profileSaving = false;

  // Notification state. `prefs` is the canonical copy of what we last saved
  // so we can roll back on failure.
  let prefs: NotificationPreferences | null = null;

  // Guideline state.
  let guidelinesLoaded = false;
  let guidelines: Guideline[] = [];
  let guidelineCreating = false;

  // Teams state — lazy-mounted on first tab activation.
  let teamHandle: TeamManagementHandle | null = null;

  // Per-row toggle cleanups so re-renders do not leak listeners.
  let notificationCleanups: Array<() => void> = [];

  // ---- Tab switching ----------------------------------------------------
  function setActiveTab(tab: SettingsTab): void {
    activeTab = tab;
    for (const key of Object.keys(tabSections) as SettingsTab[]) {
      const isActive = key === tab;
      tabSections[key].hidden = !isActive;
      paintTabButton(tabButtons[key], isActive);
    }
    if (tab === 'profile' && !profileLoaded) {
      void loadProfile();
    }
    if (tab === 'notifications' && prefs === null) {
      void loadNotifications();
    }
    if (tab === 'guidelines' && !guidelinesLoaded) {
      void loadGuidelines();
    }
    if (tab === 'teams' && teamHandle === null) {
      // The TeamManagement component owns its own initial fetch.
      teamHandle = mountTeamManagement(teamsContainer, { apiFetch });
    }
  }

  function paintTabButton(btn: HTMLButtonElement, active: boolean): void {
    btn.style.borderBottom = active ? '2px solid #4f46e5' : '2px solid transparent';
    btn.style.color = active ? '#4f46e5' : '#666';
    btn.style.fontWeight = active ? '600' : '400';
  }

  // ---- Profile tab ------------------------------------------------------
  async function loadProfile(): Promise<void> {
    profileLoading.hidden = false;
    profileForm.hidden = true;
    setProfileMessage('');
    try {
      const user = await fetchUser();
      profileNameInput.value = user.name;
      profileEmailInput.value = user.email;
      profileAvatarInput.value = user.avatarUrl ?? '';
      profileLoaded = true;
      profileForm.hidden = false;
    } catch {
      setProfileMessage('Failed to load profile.', 'error');
    } finally {
      profileLoading.hidden = true;
    }
  }

  async function saveProfile(): Promise<void> {
    if (profileSaving) return;
    profileSaving = true;
    setProfileSubmitLabel(true);
    setProfileMessage('');
    const avatarValue = profileAvatarInput.value.trim();
    try {
      await apiFetch('/users/me', {
        method: 'PUT',
        body: JSON.stringify({
          name: profileNameInput.value,
          email: profileEmailInput.value,
          avatarUrl: avatarValue === '' ? undefined : avatarValue,
        }),
      });
      setProfileMessage('Profile updated.', 'success');
    } catch (err) {
      setProfileMessage(
        err instanceof Error ? err.message : 'Failed to save.',
        'error',
      );
    } finally {
      profileSaving = false;
      setProfileSubmitLabel(false);
    }
  }

  function setProfileSubmitLabel(saving: boolean): void {
    profileSubmit.disabled = saving;
    profileSubmit.textContent = saving ? 'Saving…' : 'Save';
    profileSubmit.style.cursor = saving ? 'not-allowed' : 'pointer';
  }

  function setProfileMessage(
    message: string,
    kind: 'success' | 'error' = 'error',
  ): void {
    if (!message) {
      profileMessage.hidden = true;
      profileMessage.textContent = '';
      return;
    }
    profileMessage.hidden = false;
    profileMessage.textContent = message;
    profileMessage.style.color = kind === 'success' ? '#16a34a' : '#dc2626';
  }

  // ---- Notifications tab -----------------------------------------------
  async function loadNotifications(): Promise<void> {
    notificationsLoading.hidden = false;
    notificationsContent.hidden = true;
    notificationsError.hidden = true;
    try {
      const user = await fetchUser();
      prefs = { ...user.notificationPreferences };
      renderNotifications();
      notificationsContent.hidden = false;
    } catch {
      showNotificationsError('Failed to load preferences.');
    } finally {
      notificationsLoading.hidden = true;
    }
  }

  function renderNotifications(): void {
    // Detach previous toggle listeners before rebuilding the list.
    for (const cleanup of notificationCleanups) cleanup();
    notificationCleanups = [];
    notificationsList.replaceChildren();
    if (prefs === null) return;

    for (const row of NOTIFICATION_ROWS) {
      notificationsList.appendChild(renderNotificationRow(row));
    }
  }

  function renderNotificationRow(row: NotificationRow): HTMLElement {
    const fragment = cloneTemplate('tpl-settings-notification-row', {
      label: row.label,
    });
    const el = fragment.firstElementChild as HTMLElement;
    const toggle = el.querySelector<HTMLButtonElement>(
      '[data-role="notification-toggle"]',
    )!;
    paintToggle(toggle, prefs?.[row.key] === true);

    const cleanup = bindEvents(el, {
      toggle: (e) => {
        e.preventDefault();
        void handleNotificationToggle(row.key, toggle);
      },
    });
    notificationCleanups.push(cleanup);
    return el;
  }

  async function handleNotificationToggle(
    key: keyof NotificationPreferences,
    toggle: HTMLButtonElement,
  ): Promise<void> {
    if (prefs === null) return;
    notificationsError.hidden = true;
    const previous = prefs;
    const next: NotificationPreferences = { ...prefs, [key]: !prefs[key] };
    prefs = next;
    paintToggle(toggle, next[key]);
    try {
      await apiFetch('/users/me/notifications', {
        method: 'PUT',
        body: JSON.stringify(next),
      });
    } catch {
      // Revert on failure.
      prefs = previous;
      paintToggle(toggle, previous[key]);
      showNotificationsError('Failed to update preference.');
    }
  }

  function paintToggle(toggle: HTMLButtonElement, on: boolean): void {
    toggle.setAttribute('aria-checked', on ? 'true' : 'false');
    toggle.style.background = on ? '#4f46e5' : '#d1d5db';
    const knob = toggle.querySelector<HTMLElement>(
      '[data-role="notification-knob"]',
    );
    if (knob) {
      knob.style.left = on ? '20px' : '2px';
    }
  }

  function showNotificationsError(message: string): void {
    notificationsError.hidden = false;
    notificationsError.textContent = message;
  }

  // ---- Guidelines tab ---------------------------------------------------
  async function loadGuidelines(): Promise<void> {
    guidelinesLoading.hidden = false;
    guidelinesContent.hidden = true;
    guidelinesError.hidden = true;
    try {
      guidelines = await apiFetch<Guideline[]>('/guidelines');
      guidelinesLoaded = true;
      renderGuidelines();
      guidelinesContent.hidden = false;
    } catch {
      showGuidelinesError('Failed to load guidelines.');
    } finally {
      guidelinesLoading.hidden = true;
    }
  }

  function renderGuidelines(): void {
    guidelinesList.replaceChildren();
    if (guidelines.length === 0) {
      guidelinesEmpty.hidden = false;
      return;
    }
    guidelinesEmpty.hidden = true;
    for (const g of guidelines) {
      guidelinesList.appendChild(renderGuidelineRow(g));
    }
  }

  function renderGuidelineRow(g: Guideline): HTMLElement {
    const fragment = cloneTemplate('tpl-settings-guideline-row', {
      name: g.name,
    });
    const row = fragment.firstElementChild as HTMLElement;
    attr(row, 'data-guideline-id', g.id);

    const badge = row.querySelector<HTMLElement>('[data-role="default-badge"]');
    if (badge) {
      badge.hidden = !g.isDefault;
    }

    const desc = row.querySelector<HTMLElement>('[data-role="description"]');
    if (desc) {
      if (g.description) {
        desc.hidden = false;
        text(desc, g.description);
      } else {
        desc.hidden = true;
      }
    }

    return row;
  }

  async function handleCreateGuideline(): Promise<void> {
    if (guidelineCreating) return;
    const name = guidelineNameInput.value.trim();
    const description = guidelineDescInput.value.trim();
    if (!name) return;
    guidelineCreating = true;
    setGuidelineSubmitLabel(true);
    guidelinesError.hidden = true;
    try {
      await apiFetch('/guidelines', {
        method: 'POST',
        body: JSON.stringify({ name, description }),
      });
      guidelineNameInput.value = '';
      guidelineDescInput.value = '';
      // Re-fetch the list to pick up the new row in canonical server order.
      guidelines = await apiFetch<Guideline[]>('/guidelines');
      renderGuidelines();
    } catch (err) {
      showGuidelinesError(
        err instanceof Error ? err.message : 'Failed to create guideline.',
      );
    } finally {
      guidelineCreating = false;
      setGuidelineSubmitLabel(false);
      syncGuidelineSubmitDisabled();
    }
  }

  function setGuidelineSubmitLabel(creating: boolean): void {
    guidelineSubmit.textContent = creating ? 'Creating…' : 'Create Guideline';
    if (creating) {
      guidelineSubmit.disabled = true;
      guidelineSubmit.style.cursor = 'not-allowed';
      guidelineSubmit.style.opacity = '0.6';
    }
  }

  function syncGuidelineSubmitDisabled(): void {
    if (guidelineCreating) return;
    const enabled = guidelineNameInput.value.trim().length > 0;
    guidelineSubmit.disabled = !enabled;
    guidelineSubmit.style.cursor = enabled ? 'pointer' : 'not-allowed';
    guidelineSubmit.style.opacity = enabled ? '1' : '0.6';
  }

  function showGuidelinesError(message: string): void {
    guidelinesError.hidden = false;
    guidelinesError.textContent = message;
  }

  // ---- Shared user fetch ------------------------------------------------
  // Both the Profile and Notifications tabs need the current user. The
  // shared `fetchCurrentUser` helper in `lib/api.ts` handles the response-
  // shape normalisation (`{ user }` wrapper or bare `User`) so this page
  // and `TeamManagement` use the same code path. Tests inject a fake
  // `apiFetch` via `options`; the helper accepts the shim so we route
  // through it and the test observes the call.
  function fetchUser(): Promise<User> {
    return fetchCurrentUser(apiFetch);
  }

  // ---- Wiring -----------------------------------------------------------
  const cleanupEvents = bindEvents(contentRoot, {
    selectProfile: (e) => {
      e.preventDefault();
      setActiveTab('profile');
    },
    selectNotifications: (e) => {
      e.preventDefault();
      setActiveTab('notifications');
    },
    selectGuidelines: (e) => {
      e.preventDefault();
      setActiveTab('guidelines');
    },
    selectTeams: (e) => {
      e.preventDefault();
      setActiveTab('teams');
    },
    saveProfile: (e) => {
      e.preventDefault();
      void saveProfile();
    },
    createGuideline: (e) => {
      e.preventDefault();
      void handleCreateGuideline();
    },
  });

  // The guideline form's submit button is disabled until the name input has
  // a non-empty trimmed value.
  const onGuidelineNameInput = (): void => syncGuidelineSubmitDisabled();
  guidelineNameInput.addEventListener('input', onGuidelineNameInput);

  // Initial paint + initial tab.
  setActiveTab(activeTab);

  // Mount inside the layout shell.
  const teardownLayout = mountAppLayout(rootEl, contentRoot);

  return () => {
    cleanupEvents();
    for (const cleanup of notificationCleanups) cleanup();
    notificationCleanups = [];
    guidelineNameInput.removeEventListener('input', onGuidelineNameInput);
    teamHandle?.dispose();
    teamHandle = null;
    teardownLayout();
    contentRoot.remove();
  };
}
