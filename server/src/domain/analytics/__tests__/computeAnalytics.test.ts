// Unit tests for the computeAnalytics use case (Phase 1.5 / task 4.11.2).

import { describe, it, expect } from 'vitest';

import {
  FakeAnalyticsRepo,
  FakeAnnotationRepo,
  FakeClock,
  FakeProjectRepo,
  FakeTeamMemberRepo,
} from '../../../__tests__/fakes/index.js';
import { ComputeAnalytics } from '../usecases/computeAnalytics.js';

const TARGET = {
  cssSelector: 'body',
  xpath: '/html/body',
  pageX: 0,
  pageY: 0,
  tagName: 'body',
  textSnippet: '',
};
const ENV = {
  browserFamily: 'Chrome' as const,
  browserVersion: '120',
  osFamily: 'macOS' as const,
  osVersion: '14',
  deviceType: 'desktop' as const,
  userAgentRaw: 'test-ua',
};

async function buildSut() {
  const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
  const teamMemberRepo = new FakeTeamMemberRepo({ clock });
  const projectRepo = new FakeProjectRepo({ clock, teamMemberRepo });
  const annotationRepo = new FakeAnnotationRepo(clock);
  const analyticsRepo = new FakeAnalyticsRepo(annotationRepo);

  const project = await projectRepo.insert({
    name: 'P',
    urls: ['https://example.com'],
    ownerId: 'owner-1',
  });

  // Seed three annotations with mixed dimensions.
  await annotationRepo.insert({
    projectId: project.id,
    pageId: 'page-1',
    type: 'note',
    severity: 'critical',
    status: 'active',
    body: 'a',
    authorId: 'owner-1',
    target: TARGET,
    environment: ENV,
    pinNumber: 1,
  });
  await annotationRepo.insert({
    projectId: project.id,
    pageId: 'page-1',
    type: 'suggestion',
    severity: 'minor',
    status: 'resolved',
    body: 'b',
    authorId: 'owner-1',
    target: TARGET,
    environment: ENV,
    pinNumber: 2,
  });
  await annotationRepo.insert({
    projectId: project.id,
    pageId: 'page-1',
    type: 'note',
    severity: 'minor',
    status: 'in_progress',
    body: 'c',
    authorId: 'owner-1',
    target: TARGET,
    environment: ENV,
    pinNumber: 3,
  });

  const usecase = new ComputeAnalytics({
    projectRepo,
    teamMemberRepo,
    analyticsRepo,
  });

  return { usecase, project };
}

describe('computeAnalytics use case', () => {
  it('returns roll-up buckets across severity, type, status, and browser', async () => {
    const { usecase, project } = await buildSut();

    const result = await usecase.execute({
      userId: 'owner-1',
      projectId: project.id,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(3);
    expect(result.value.bySeverity.critical).toBe(1);
    expect(result.value.bySeverity.minor).toBe(2);
    expect(result.value.byType.note).toBe(2);
    expect(result.value.byType.suggestion).toBe(1);
    expect(result.value.byStatus.active).toBe(1);
    expect(result.value.byStatus.in_progress).toBe(1);
    expect(result.value.byStatus.resolved).toBe(1);
    expect(result.value.byBrowser.Chrome).toBe(3);
  });

  it('returns Forbidden for a non-member non-owner', async () => {
    const { usecase, project } = await buildSut();

    const result = await usecase.execute({
      userId: 'stranger',
      projectId: project.id,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Forbidden');
  });

  it('returns NotFound when the project does not exist', async () => {
    const { usecase } = await buildSut();

    const result = await usecase.execute({
      userId: 'owner-1',
      projectId: '00000000-0000-0000-0000-000000000000',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('NotFound');
  });
});
