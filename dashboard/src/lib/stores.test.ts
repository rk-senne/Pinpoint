import { describe, it, expect, beforeEach } from 'vitest';

import type {
  Annotation,
  Project,
  User,
} from '@pinpoint/shared';
import {
  authStore,
  currentAnnotationsStore,
  loadProjects,
  membersStore,
  projectsStore,
  resetStores,
  setAnnotations,
  setCurrentUser,
  setMembers,
  setProjectListFilter,
  stores,
  type ProjectMember,
} from './stores.js';

const sampleUser: User = {
  id: 'user-1',
  email: 'a@b.test',
  name: 'Tester',
  notificationPreferences: {
    newAnnotation: true,
    newComment: true,
    promotedToOwner: true,
    projectDeleted: true,
  },
  createdAt: '2024-01-01T00:00:00.000Z',
};

const sampleProject: Project = {
  id: 'project-1',
  name: 'Site',
  urls: ['https://example.com'],
  status: 'active',
  ownerId: sampleUser.id,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

const sampleAnnotation: Annotation = {
  id: 'ann-1',
  projectId: sampleProject.id,
  pageId: 'page-1',
  pageUrl: 'https://example.com',
  type: 'note',
  severity: 'major',
  status: 'active',
  body: 'hello',
  authorId: sampleUser.id,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  target: {
    cssSelector: 'body',
    xpath: '/html/body',
    pageX: 0,
    pageY: 0,
    tagName: 'body',
    textSnippet: '',
  },
  environment: {
    browserFamily: 'Chrome',
    browserVersion: '120.0.0',
    osFamily: 'macOS',
    osVersion: '14.0',
    deviceType: 'desktop',
    userAgentRaw: 'Mozilla/5.0',
  },
  pinNumber: 1,
};

const sampleMember: ProjectMember = {
  userId: sampleUser.id,
  name: 'Tester',
  email: 'a@b.test',
  avatarUrl: null,
  role: 'owner',
};

const archivedProject: Project = {
  ...sampleProject,
  id: 'project-2',
  status: 'archived',
};

describe('dashboard stores', () => {
  beforeEach(() => {
    resetStores();
  });

  it('exposes signal slices grouped by surface', () => {
    // Each surface is reachable through the aggregator and through its
    // direct named export. Both references identify the same signal.
    expect(stores.auth.currentUser).toBe(authStore.currentUser);
    expect(stores.projects.list).toBe(projectsStore.list);
    expect(stores.projects.active).toBe(projectsStore.active);
    expect(stores.projects.archived).toBe(projectsStore.archived);
    expect(stores.currentAnnotations.list).toBe(currentAnnotationsStore.list);
    expect(stores.members.list).toBe(membersStore.list);
  });

  it('initializes auth slices to logged-out defaults', () => {
    expect(authStore.currentUser.get()).toBeNull();
    expect(authStore.isAuthenticated.get()).toBe(false);
  });

  it('initializes project list with an active filter and empty list', () => {
    expect(projectsStore.list.get()).toEqual([]);
    expect(projectsStore.filter.get()).toBe('active');
    expect(projectsStore.active.get()).toEqual([]);
    expect(projectsStore.archived.get()).toEqual([]);
  });

  it('initializes annotations and members as empty', () => {
    expect(currentAnnotationsStore.list.get()).toEqual([]);
    expect(membersStore.list.get()).toEqual([]);
  });

  it('notifies subscribers when a slice changes', () => {
    const seen: Array<User | null> = [];
    const unsubscribe = authStore.currentUser.subscribe((u) => seen.push(u));

    authStore.currentUser.set(sampleUser);
    authStore.currentUser.set(null);

    // subscribe fires once with the current value (null), then once per set.
    expect(seen).toEqual([null, sampleUser, null]);
    unsubscribe();
  });

  it('does not cross-fire between unrelated slices', () => {
    let projectsListCalls = 0;
    const off = projectsStore.list.subscribe(() => {
      projectsListCalls += 1;
    });

    // initial fire
    expect(projectsListCalls).toBe(1);

    projectsStore.filter.set('archived');
    membersStore.list.set([sampleMember]);

    expect(projectsListCalls).toBe(1);
    off();
  });

  it('accepts domain values on each typed slice', () => {
    authStore.currentUser.set(sampleUser);
    authStore.isAuthenticated.set(true);

    projectsStore.list.set([sampleProject]);
    projectsStore.filter.set('archived');

    currentAnnotationsStore.list.set([sampleAnnotation]);
    membersStore.list.set([sampleMember]);

    expect(authStore.currentUser.get()).toEqual(sampleUser);
    expect(authStore.isAuthenticated.get()).toBe(true);
    expect(projectsStore.list.get()).toEqual([sampleProject]);
    expect(projectsStore.filter.get()).toBe('archived');
    expect(currentAnnotationsStore.list.get()).toEqual([sampleAnnotation]);
    expect(membersStore.list.get()).toEqual([sampleMember]);
  });

  it('resetStores returns every slice to its initial value', () => {
    authStore.currentUser.set(sampleUser);
    authStore.isAuthenticated.set(true);
    projectsStore.list.set([sampleProject]);
    projectsStore.filter.set('archived');
    projectsStore.active.set([sampleProject]);
    projectsStore.archived.set([sampleProject]);
    currentAnnotationsStore.list.set([sampleAnnotation]);
    membersStore.list.set([sampleMember]);

    resetStores();

    expect(authStore.currentUser.get()).toBeNull();
    expect(authStore.isAuthenticated.get()).toBe(false);
    expect(projectsStore.list.get()).toEqual([]);
    expect(projectsStore.filter.get()).toBe('active');
    expect(projectsStore.active.get()).toEqual([]);
    expect(projectsStore.archived.get()).toEqual([]);
    expect(currentAnnotationsStore.list.get()).toEqual([]);
    expect(membersStore.list.get()).toEqual([]);
  });
});

describe('dashboard store actions', () => {
  beforeEach(() => {
    resetStores();
  });

  it('setCurrentUser flips isAuthenticated alongside currentUser', () => {
    setCurrentUser(sampleUser);
    expect(authStore.currentUser.get()).toEqual(sampleUser);
    expect(authStore.isAuthenticated.get()).toBe(true);

    setCurrentUser(null);
    expect(authStore.currentUser.get()).toBeNull();
    expect(authStore.isAuthenticated.get()).toBe(false);
  });

  it('loadProjects splits the list into active and archived buckets', () => {
    loadProjects([sampleProject, archivedProject]);

    expect(projectsStore.list.get()).toEqual([sampleProject, archivedProject]);
    expect(projectsStore.active.get()).toEqual([sampleProject]);
    expect(projectsStore.archived.get()).toEqual([archivedProject]);
  });

  it('loadProjects updates the splits even when previously populated', () => {
    loadProjects([sampleProject, archivedProject]);
    loadProjects([archivedProject]);

    expect(projectsStore.active.get()).toEqual([]);
    expect(projectsStore.archived.get()).toEqual([archivedProject]);
  });

  it('setProjectListFilter switches between active and archived', () => {
    setProjectListFilter('archived');
    expect(projectsStore.filter.get()).toBe('archived');

    setProjectListFilter('active');
    expect(projectsStore.filter.get()).toBe('active');
  });

  it('setAnnotations / setMembers replace their lists', () => {
    setAnnotations([sampleAnnotation]);
    setMembers([sampleMember]);

    expect(currentAnnotationsStore.list.get()).toEqual([sampleAnnotation]);
    expect(membersStore.list.get()).toEqual([sampleMember]);
  });
});
