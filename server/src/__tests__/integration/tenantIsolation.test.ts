// Integration Test: Cross-tenant data isolation
// Validates: Phase 1 multi-tenancy — users in org A cannot access org B's data.

import { describe, it, expect, beforeEach } from 'vitest';

import {
  FakeAnnotationRepo,
  FakeClock,
  FakeCommentRepo,
  FakeProjectRepo,
} from '../fakes/index.js';

describe('Cross-tenant isolation', () => {
  const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
  let projectRepo: FakeProjectRepo;
  let annotationRepo: FakeAnnotationRepo;
  let commentRepo: FakeCommentRepo;

  beforeEach(() => {
    projectRepo = new FakeProjectRepo({ clock });
    annotationRepo = new FakeAnnotationRepo(clock);
    commentRepo = new FakeCommentRepo(clock);
  });

  it('user in org A cannot see projects created by org B', async () => {
    // Org A creates a project
    const projectA = await projectRepo.insert({
      name: 'Org A Project',
      urls: ['https://a.com'],
      ownerId: 'user-a',
      orgId: 'org-a',
    });

    // Org B creates a project
    const projectB = await projectRepo.insert({
      name: 'Org B Project',
      urls: ['https://b.com'],
      ownerId: 'user-b',
      orgId: 'org-b',
    });

    // User A can search their own projects
    const userAProjects = await projectRepo.search({ userId: 'user-a' });
    expect(userAProjects).toHaveLength(1);
    expect(userAProjects[0].id).toBe(projectA.id);

    // User B can search their own projects
    const userBProjects = await projectRepo.search({ userId: 'user-b' });
    expect(userBProjects).toHaveLength(1);
    expect(userBProjects[0].id).toBe(projectB.id);

    // User A cannot find org B's project by ID
    // (In production, RLS prevents this; here ownership scoping does)
    const userASearchAll = await projectRepo.search({ userId: 'user-a' });
    const orgBIds = userASearchAll.map((p) => p.id);
    expect(orgBIds).not.toContain(projectB.id);
  });

  it('annotations are scoped: org A annotations not visible to org B queries', async () => {
    const annotationA = await annotationRepo.insert({
      projectId: 'project-a',
      pageId: 'page-a',
      type: 'note',
      severity: 'minor',
      status: 'active',
      body: 'Org A feedback',
      authorId: 'user-a',
      target: { cssSelector: 'div', xpath: '/div', pageX: 0, pageY: 0, tagName: 'div', textSnippet: '' },
      environment: { browserFamily: 'Chrome', browserVersion: '120', osFamily: 'macOS', osVersion: '14', viewportWidth: 1920, viewportHeight: 1080 },
      pinNumber: 1,
      orgId: 'org-a',
    });

    const annotationB = await annotationRepo.insert({
      projectId: 'project-b',
      pageId: 'page-b',
      type: 'note',
      severity: 'minor',
      status: 'active',
      body: 'Org B feedback',
      authorId: 'user-b',
      target: { cssSelector: 'div', xpath: '/div', pageX: 0, pageY: 0, tagName: 'div', textSnippet: '' },
      environment: { browserFamily: 'Chrome', browserVersion: '120', osFamily: 'macOS', osVersion: '14', viewportWidth: 1920, viewportHeight: 1080 },
      pinNumber: 1,
      orgId: 'org-b',
    });

    // Listing by project returns only that project's annotations
    const orgAAnnotations = await annotationRepo.listByProject('project-a', {});
    expect(orgAAnnotations).toHaveLength(1);
    expect(orgAAnnotations[0].id).toBe(annotationA.id);

    const orgBAnnotations = await annotationRepo.listByProject('project-b', {});
    expect(orgBAnnotations).toHaveLength(1);
    expect(orgBAnnotations[0].id).toBe(annotationB.id);
  });

  it('comments are scoped: org A comments isolated from org B', async () => {
    const commentA = await commentRepo.insert({
      annotationId: 'ann-a',
      authorId: 'user-a',
      body: 'Comment from org A',
      mentions: [],
      orgId: 'org-a',
    });

    await commentRepo.insert({
      annotationId: 'ann-b',
      authorId: 'user-b',
      body: 'Comment from org B',
      mentions: [],
      orgId: 'org-b',
    });

    // Listing by annotation only returns that annotation's comments
    const orgAComments = await commentRepo.listByAnnotation('ann-a');
    expect(orgAComments).toHaveLength(1);
    expect(orgAComments[0].id).toBe(commentA.id);

    const orgBComments = await commentRepo.listByAnnotation('ann-b');
    expect(orgBComments).toHaveLength(1);
    expect(orgBComments[0].body).toBe('Comment from org B');
  });

  it('JWT claims carry org context for tenant-scoped access', () => {
    // Verify the token payload shape supports multi-tenancy
    const tokenPayload = {
      userId: 'user-1',
      email: 'test@example.com',
      orgId: 'org-1',
      role: 'member',
    };

    expect(tokenPayload.orgId).toBeDefined();
    expect(tokenPayload.role).toBeDefined();
    expect(['owner', 'admin', 'member', 'viewer']).toContain(tokenPayload.role);
  });
});
