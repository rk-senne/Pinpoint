// Unit tests for the deletePage use case (Phase 1.5 / task 4.11.2).

import { describe, it, expect } from 'vitest';

import {
  FakeAnnotationRepo,
  FakeClock,
  FakePageRepo,
  FakeProjectRepo,
  FakeTeamMemberRepo,
} from '../../../__tests__/fakes/index.js';
import { DeletePage } from '../usecases/deletePage.js';
import type { DOMTarget } from '../../annotation/DOMTarget.js';
import type { EnvironmentMetadata } from '../../annotation/EnvironmentMetadata.js';

const TARGET: DOMTarget = {
  cssSelector: 'body',
  xpath: '/html/body',
  pageX: 0,
  pageY: 0,
  tagName: 'body',
  textSnippet: '',
};

const ENV: EnvironmentMetadata = {
  browserFamily: 'Chrome',
  browserVersion: '120',
  osFamily: 'macOS',
  osVersion: '14',
  deviceType: 'desktop',
  userAgentRaw: 'test-ua',
};

async function buildSut() {
  const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
  const teamMemberRepo = new FakeTeamMemberRepo({ clock });
  const projectRepo = new FakeProjectRepo({ clock, teamMemberRepo });
  const pageRepo = new FakePageRepo(clock);
  const annotationRepo = new FakeAnnotationRepo(clock);

  const project = await projectRepo.insert({
    name: 'Site',
    urls: ['https://example.com'],
    ownerId: 'owner-1',
  });
  const page = await pageRepo.insert({
    projectId: project.id,
    url: 'https://example.com',
  });

  const usecase = new DeletePage({
    projectRepo,
    pageRepo,
    annotationRepo,
    teamMemberRepo,
  });

  return { usecase, project, page, pageRepo, annotationRepo };
}

describe('deletePage use case', () => {
  it('deletes an empty page for the owner', async () => {
    const { usecase, project, page, pageRepo } = await buildSut();

    const result = await usecase.execute({
      userId: 'owner-1',
      projectId: project.id,
      pageId: page.id,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.annotationCount).toBe(0);
    expect(pageRepo.pages.has(page.id)).toBe(false);
  });

  it('returns Conflict when the page has annotations and onNonEmpty=block', async () => {
    const { usecase, project, page, annotationRepo } = await buildSut();
    await annotationRepo.insert({
      projectId: project.id,
      pageId: page.id,
      type: 'note',
      severity: 'minor',
      status: 'active',
      body: 'hello',
      authorId: 'owner-1',
      target: TARGET,
      environment: ENV,
      pinNumber: 1,
    });

    const result = await usecase.execute({
      userId: 'owner-1',
      projectId: project.id,
      pageId: page.id,
      onNonEmpty: 'block',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Conflict');
  });

  it('returns Forbidden for a stranger', async () => {
    const { usecase, project, page } = await buildSut();

    const result = await usecase.execute({
      userId: 'stranger',
      projectId: project.id,
      pageId: page.id,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Forbidden');
  });
});
