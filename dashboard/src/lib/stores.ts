// dashboard/src/lib/stores.ts
//
// In-memory stores for the Dashboard surface, per Requirement 31.1
// (UI Implementation Without React) and design Key Decision #2:
// "one in-memory store per surface, exposing `signal()` slices. No Redux,
// no MobX."
//
// Each exported store is a plain object whose properties are `Signal<T>`
// instances from `@pinpoint/shared`. Components subscribe to the
// individual signals they care about; they do not subscribe to the store
// object as a whole. This keeps fan-out tight: setting `projects.active`
// only re-runs subscribers of `projects.active`, not subscribers of
// `projects.archived`.
//
// Authoritative mutators (login, project fetch, etc.) live in the lib
// modules that own each surface (`auth.ts`, `api.ts`, etc.). Pages read
// these stores via `subscribe()` and update them through the action
// helpers exported here. The actions are deliberately thin: they update
// the relevant slices and nothing else. Data fetching, error handling,
// and routing are kept out of this module.

import { signal, type Signal } from '@pinpoint/shared';
import type {
  Annotation,
  Project,
  TeamRole,
  User,
} from '@pinpoint/shared';

/**
 * The shape of a project member returned by `GET /api/v1/projects/:id/members`.
 *
 * The server route assembles team members joined with users plus the
 * project owner; the dashboard assignee dropdown and the extension
 * MentionAutocomplete consume this shape (Req 22.4).
 */
export interface ProjectMember {
  userId: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  role: string;
}

/**
 * Filter for the project list sidebar. The dashboard surfaces archived
 * projects through a separate filter rather than mixing them with
 * active projects (Req 2.x).
 */
export type ProjectListFilter = 'active' | 'archived';

// --- Auth surface -----------------------------------------------------

export interface AuthStore {
  /** The currently signed-in user, or null when logged out. */
  currentUser: Signal<User | null>;
  /**
   * Whether a user is currently authenticated. Tracked as its own slice
   * so callers can subscribe to login/logout transitions without
   * re-deriving from `currentUser` on every render.
   *
   * The CSRF token itself lives in `lib/auth.ts` as a module-level slot
   * (read by `apiFetch` to attach `X-CSRF-Token`); the store does not
   * mirror it because no consumer needed reactive subscription to the
   * raw token value.
   */
  isAuthenticated: Signal<boolean>;
}

export const authStore: AuthStore = {
  currentUser: signal<User | null>(null),
  isAuthenticated: signal<boolean>(false),
};

// --- Project list surface --------------------------------------------

export interface ProjectsStore {
  /**
   * All projects returned from the server, irrespective of status. Kept
   * as the canonical list so callers can re-derive filters without a
   * round-trip.
   */
  list: Signal<Project[]>;
  /** Active filter driving the sidebar list. Defaults to `active`. */
  filter: Signal<ProjectListFilter>;
  /**
   * Projects with `status === 'active'`. Maintained by `loadProjects`
   * so subscribers that only care about active projects do not re-run
   * when archived projects change.
   */
  active: Signal<Project[]>;
  /** Projects with `status === 'archived'`. */
  archived: Signal<Project[]>;
}

export const projectsStore: ProjectsStore = {
  list: signal<Project[]>([]),
  filter: signal<ProjectListFilter>('active'),
  active: signal<Project[]>([]),
  archived: signal<Project[]>([]),
};

// --- Current annotations surface -------------------------------------

export interface CurrentAnnotationsStore {
  /** Annotations for the currently viewed project. */
  list: Signal<Annotation[]>;
}

export const currentAnnotationsStore: CurrentAnnotationsStore = {
  list: signal<Annotation[]>([]),
};

// --- Members surface --------------------------------------------------

export interface MembersStore {
  /** Members of the currently viewed project. */
  list: Signal<ProjectMember[]>;
}

export const membersStore: MembersStore = {
  list: signal<ProjectMember[]>([]),
};

// --- Teams surface ----------------------------------------------------

/**
 * A flattened team-member record returned by `GET /api/v1/teams`. The
 * dashboard team management UI renders the member list joined with user
 * information for display alongside role controls (Req 9.2, 9.3, 9.5).
 */
export interface TeamMemberSummary {
  userId: string;
  role: TeamRole;
  email?: string;
  name?: string;
}

/**
 * A team enriched with the caller's role and the team's full member list.
 * Mirrors the shape returned by `GET /api/v1/teams` once `members` is
 * populated server-side.
 */
export interface TeamWithMembers {
  id: string;
  name: string;
  ownerId: string;
  createdAt: string;
  role: TeamRole;
  members: TeamMemberSummary[];
}

export interface TeamsStore {
  /** Teams the current user belongs to. */
  list: Signal<TeamWithMembers[]>;
}

export const teamsStore: TeamsStore = {
  list: signal<TeamWithMembers[]>([]),
};

// --- Aggregator -------------------------------------------------------

/**
 * Single import point for surfaces that touch multiple stores. Pages and
 * components are free to import the individual stores when they only
 * consume one surface.
 */
export const stores = {
  auth: authStore,
  projects: projectsStore,
  currentAnnotations: currentAnnotationsStore,
  members: membersStore,
  teams: teamsStore,
} as const;

// --- Actions ----------------------------------------------------------
//
// Thin synchronous setters. Network calls live in `lib/api.ts` and
// `lib/auth.ts`; those modules call the actions below once a response
// arrives. Keeping fetch-and-mutate split makes both halves trivial to
// unit-test.

/** Set the signed-in user. Pass `null` on logout. */
export function setCurrentUser(user: User | null): void {
  authStore.currentUser.set(user);
  authStore.isAuthenticated.set(user !== null);
}

/**
 * Replace the project list and re-derive the `active` and `archived`
 * splits in one shot. Callers pass the full result of
 * `GET /api/v1/projects`.
 */
export function loadProjects(projects: Project[]): void {
  projectsStore.list.set(projects);
  projectsStore.active.set(projects.filter((p) => p.status === 'active'));
  projectsStore.archived.set(projects.filter((p) => p.status === 'archived'));
}

/** Switch between the active and archived sidebar filters. */
export function setProjectListFilter(filter: ProjectListFilter): void {
  projectsStore.filter.set(filter);
}

/** Replace the annotations list for the current project. */
export function setAnnotations(annotations: Annotation[]): void {
  currentAnnotationsStore.list.set(annotations);
}

/** Replace the members list for the current project. */
export function setMembers(members: ProjectMember[]): void {
  membersStore.list.set(members);
}

/** Replace the teams list returned by `GET /api/v1/teams`. */
export function setTeams(teams: TeamWithMembers[]): void {
  teamsStore.list.set(teams);
}

/**
 * Reset every store to its initial state. Intended for test isolation
 * and for the logout flow, which clears all surfaces in one shot.
 */
export function resetStores(): void {
  authStore.currentUser.set(null);
  authStore.isAuthenticated.set(false);

  projectsStore.list.set([]);
  projectsStore.filter.set('active');
  projectsStore.active.set([]);
  projectsStore.archived.set([]);

  currentAnnotationsStore.list.set([]);
  membersStore.list.set([]);
  teamsStore.list.set([]);
}
