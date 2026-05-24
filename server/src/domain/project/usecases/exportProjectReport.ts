// exportProjectReport use case (Phase 1.5 / task 4.7.10).
//
// Generates a downloadable report for a project in either PDF or CSV
// format (Req 34). Validates input, enforces project access, then
// delegates the rendering to the `ReportRenderer` port. After a
// successful render, an `export.completed` domain event is emitted so the
// inbound WebSocket adapter can broadcast it to project subscribers.
//
// Pure infrastructure (PDFKit, S3 fetches) lives behind ports — the
// domain only sees the rendered bytes and the metadata needed to populate
// HTTP headers.

import { Forbidden, NotFound, Validation, err, ok } from '../../shared/DomainError.js';
import type { DomainError, Result } from '../../shared/DomainError.js';
import type { EventBus } from '../../shared/ports/EventBus.js';
import type { ProjectRepo } from '../ports/ProjectRepo.js';
import type { TeamMemberRepo } from '../../team/ports/TeamMemberRepo.js';
import type { ReportRenderer, ReportFormat } from '../ports/ReportRenderer.js';

export interface ExportProjectReportInput {
  /** Caller's user id; must be owner or team member. */
  userId: string;
  projectId: string;
  format: ReportFormat;
}

export interface ExportProjectReportOutput {
  contentType: string;
  filename: string;
  body: Buffer;
  exportedAt: string;
  format: ReportFormat;
}

export interface ExportProjectReportDeps {
  projectRepo: ProjectRepo;
  teamMemberRepo: TeamMemberRepo;
  reportRenderer: ReportRenderer;
  eventBus: EventBus;
}

const VALID_FORMATS: ReadonlySet<ReportFormat> = new Set(['pdf', 'csv']);

export class ExportProjectReport {
  constructor(private readonly deps: ExportProjectReportDeps) {}

  async execute(
    input: ExportProjectReportInput,
  ): Promise<Result<ExportProjectReportOutput, DomainError>> {
    const { projectRepo, teamMemberRepo, reportRenderer, eventBus } = this.deps;

    if (!VALID_FORMATS.has(input.format)) {
      return err(
        new Validation('Format is required and must be "pdf" or "csv".'),
      );
    }

    const project = await projectRepo.findById(input.projectId);
    if (!project) {
      return err(new NotFound('Project not found.'));
    }

    const isOwner = project.ownerId === input.userId;
    let isTeamMember = false;
    if (!isOwner && project.teamId) {
      const membership = await teamMemberRepo.findByTeamAndUser(
        project.teamId,
        input.userId,
      );
      isTeamMember = membership != null;
    }
    if (!isOwner && !isTeamMember) {
      return err(new Forbidden('You do not have access to this project.'));
    }

    const rendered = await reportRenderer.render({
      project,
      format: input.format,
    });

    eventBus.emit({
      type: 'export.completed',
      room: `project:${project.id}`,
      payload: {
        projectId: project.id,
        format: input.format,
        exportedAt: rendered.exportedAt,
      },
    });

    return ok({
      contentType: rendered.contentType,
      filename: rendered.filename,
      body: rendered.body,
      exportedAt: rendered.exportedAt,
      format: input.format,
    });
  }
}
