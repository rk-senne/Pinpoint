// Unit tests for the exportProjectReport use case (Phase 1.5 / task 4.11.2).

import { describe, it, expect } from 'vitest';

import {
  FakeClock,
  FakeEventBus,
  FakeProjectRepo,
  FakeReportRenderer,
  FakeTeamMemberRepo,
} from '../../../__tests__/fakes/index.js';
import { ExportProjectReport } from '../usecases/exportProjectReport.js';

async function buildSut() {
  const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
  const teamMemberRepo = new FakeTeamMemberRepo({ clock });
  const projectRepo = new FakeProjectRepo({ clock, teamMemberRepo });
  const reportRenderer = new FakeReportRenderer(clock);
  const eventBus = new FakeEventBus();

  const project = await projectRepo.insert({
    name: 'Report Project',
    urls: ['https://example.com'],
    ownerId: 'owner-1',
  });

  const usecase = new ExportProjectReport({
    projectRepo,
    teamMemberRepo,
    reportRenderer,
    eventBus,
  });

  return { usecase, project, reportRenderer, eventBus };
}

describe('exportProjectReport use case', () => {
  it('renders a PDF report and emits export.completed', async () => {
    const { usecase, project, reportRenderer, eventBus } = await buildSut();

    const result = await usecase.execute({
      userId: 'owner-1',
      projectId: project.id,
      format: 'pdf',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.contentType).toBe('application/pdf');
    expect(result.value.body).toBeInstanceOf(Buffer);
    expect(reportRenderer.calls).toHaveLength(1);
    expect(eventBus.events).toHaveLength(1);
    expect(eventBus.events[0]!.type).toBe('export.completed');
  });

  it('returns Validation when the format is not pdf or csv', async () => {
    const { usecase, project } = await buildSut();

    const result = await usecase.execute({
      userId: 'owner-1',
      projectId: project.id,
      // @ts-expect-error - intentionally invalid for the test
      format: 'docx',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Validation');
  });

  it('returns Forbidden for a non-member non-owner', async () => {
    const { usecase, project } = await buildSut();

    const result = await usecase.execute({
      userId: 'stranger',
      projectId: project.id,
      format: 'csv',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Forbidden');
  });
});
