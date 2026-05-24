// Inbound HTTP adapter — projects routes (Phase 1.5 / task 4.9.1).
//
// Thin Express handlers that translate HTTP requests into Use_Case
// invocations for project lifecycle, page deletion, members, analytics,
// and report export.
//
// Routes are declared on a single Router so the composition root can
// mount it at `/api/v1/projects` (parent base path); the page-delete,
// analytics, and export sub-routes are also registered here under their
// `/:id/...` paths to keep the existing URL surface intact.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import type { CreateProject } from '../../../domain/project/usecases/createProject.js';
import type { SearchProjects } from '../../../domain/project/usecases/searchProjects.js';
import type { GetProject } from '../../../domain/project/usecases/getProject.js';
import type { ArchiveProject } from '../../../domain/project/usecases/archiveProject.js';
import type { DeleteProject } from '../../../domain/project/usecases/deleteProject.js';
import type { DeletePage } from '../../../domain/project/usecases/deletePage.js';
import type { ListProjectMembers } from '../../../domain/project/usecases/listProjectMembers.js';
import type { ResolveProjectByUrl } from '../../../domain/project/usecases/resolveProjectByUrl.js';
import type { ExportProjectReport } from '../../../domain/project/usecases/exportProjectReport.js';
import type { ComputeAnalytics } from '../../../domain/analytics/usecases/computeAnalytics.js';
import type { ProjectStatus } from '../../../domain/project/Project.js';
import { sendDomainError, sendZodFailure, paramString } from './errors.js';

export interface ProjectsRouteDeps {
  createProject: CreateProject;
  searchProjects: SearchProjects;
  getProject: GetProject;
  archiveProject: ArchiveProject;
  deleteProject: DeleteProject;
  deletePage: DeletePage;
  listProjectMembers: ListProjectMembers;
  resolveProjectByUrl: ResolveProjectByUrl;
  exportProjectReport: ExportProjectReport;
  computeAnalytics: ComputeAnalytics;
  /** Authenticated middleware injected so route order stays inside the factory. */
  authMiddleware: (req: Request, res: Response, next: import('express').NextFunction) => void;
}

const CreateProjectBodySchema = z.object({
  name: z.string().trim().min(1, 'Project name is required.'),
  urls: z
    .array(
      z
        .string()
        .trim()
        .min(1, 'URL must not be empty.')
        .refine(
          (u) => {
            try {
              const parsed = new URL(u);
              return parsed.protocol === 'http:' || parsed.protocol === 'https:';
            } catch {
              return false;
            }
          },
          { message: 'URL must be a valid HTTP or HTTPS URL.' },
        ),
    )
    .min(1, 'At least one URL is required.'),
  teamId: z.string().uuid().optional(),
});

const UpdateProjectBodySchema = z.object({
  name: z.string().trim().min(1).optional(),
  status: z.enum(['active', 'archived']).optional(),
});

const DeleteProjectBodySchema = z.object({
  confirmationToken: z.string().min(1).optional(),
});

const ExportBodySchema = z.object({
  format: z.enum(['pdf', 'csv']),
});

export function createProjectsRoutes(deps: ProjectsRouteDeps): Router {
  const {
    createProject,
    searchProjects,
    getProject,
    archiveProject,
    deleteProject,
    deletePage,
    listProjectMembers,
    resolveProjectByUrl,
    exportProjectReport,
    computeAnalytics,
    authMiddleware,
  } = deps;

  const router = Router();
  router.use(authMiddleware);

  // POST /projects --------------------------------------------------------
  router.post('/', async (req: Request, res: Response) => {
    const parsed = CreateProjectBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendZodFailure(res, 'Invalid project payload.', parsed.error.flatten());
      return;
    }
    const userId = req.user!.userId;
    const result = await createProject.execute({
      ownerUserId: userId,
      name: parsed.data.name,
      urls: parsed.data.urls,
      ...(parsed.data.teamId !== undefined ? { teamId: parsed.data.teamId } : {}),
    });
    if (!result.ok) {
      sendDomainError(res, result.error);
      return;
    }
    const { project, pages } = result.value;
    res.status(201).json({
      project: {
        id: project.id,
        name: project.name,
        urls: project.urls,
        status: project.status,
        ownerId: project.ownerId,
        teamId: project.teamId ?? null,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      },
      pages: pages.map((p) => ({
        id: p.id,
        projectId: p.projectId,
        url: p.url,
        title: p.title,
        createdAt: p.createdAt,
      })),
    });
  });

  // GET /projects ---------------------------------------------------------
  router.get('/', async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const statusRaw = typeof req.query.status === 'string' ? req.query.status : undefined;
    const status: ProjectStatus | undefined =
      statusRaw === 'active' || statusRaw === 'archived' ? statusRaw : undefined;

    const result = await searchProjects.execute({
      userId,
      ...(search !== undefined ? { search } : {}),
      ...(status !== undefined ? { status } : {}),
    });
    if (!result.ok) {
      sendDomainError(res, result.error);
      return;
    }
    res.status(200).json({
      projects: result.value.projects.map((p) => ({
        id: p.id,
        name: p.name,
        urls: p.urls,
        status: p.status,
        ownerId: p.ownerId,
        teamId: p.teamId ?? null,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      })),
    });
  });

  // GET /projects/by-url --------------------------------------------------
  // Mounted before `/:id` so the static path wins the route match.
  router.get('/by-url', async (req: Request, res: Response) => {
    const url = typeof req.query.url === 'string' ? req.query.url : '';
    const result = await resolveProjectByUrl.execute({
      userId: req.user!.userId,
      url,
    });
    if (!result.ok) {
      sendDomainError(res, result.error);
      return;
    }
    res.status(200).json(result.value);
  });

  // GET /projects/:id -----------------------------------------------------
  router.get('/:id', async (req: Request, res: Response) => {
    const result = await getProject.execute({
      userId: req.user!.userId,
      projectId: paramString(req.params.id),
    });
    if (!result.ok) {
      sendDomainError(res, result.error);
      return;
    }
    const { project, annotationCount, members } = result.value;
    res.status(200).json({
      project: {
        id: project.id,
        name: project.name,
        urls: project.urls,
        status: project.status,
        ownerId: project.ownerId,
        teamId: project.teamId ?? null,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        annotationCount,
        teamMembers: members.map((m) => ({
          userId: m.userId,
          email: m.email,
          name: m.name,
          avatarUrl: m.avatarUrl,
          role: m.role,
          joinedAt: m.joinedAt ?? null,
        })),
      },
    });
  });

  // PUT /projects/:id ----------------------------------------------------
  // Accepts a partial { name, status }. Only `status` is wired through to
  // the hex use case (`archiveProject` toggles status). `name` updates
  // are not yet covered by a hex use case, so the handler validates the
  // shape and surfaces the status path; a `name`-only request returns
  // 400 to make the gap explicit until a `RenameProject` use case lands.
  router.put('/:id', async (req: Request, res: Response) => {
    const parsed = UpdateProjectBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendZodFailure(res, 'Invalid project update payload.', parsed.error.flatten());
      return;
    }
    if (parsed.data.status === undefined) {
      res
        .status(400)
        .json({ error: 'Project rename is not yet supported via this endpoint.' });
      return;
    }
    const result = await archiveProject.execute({
      userId: req.user!.userId,
      projectId: paramString(req.params.id),
      status: parsed.data.status,
    });
    if (!result.ok) {
      sendDomainError(res, result.error);
      return;
    }
    const project = result.value.project;
    res.status(200).json({
      project: {
        id: project.id,
        name: project.name,
        urls: project.urls,
        status: project.status,
        ownerId: project.ownerId,
        teamId: project.teamId ?? null,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      },
    });
  });

  // DELETE /projects/:id -------------------------------------------------
  router.delete('/:id', async (req: Request, res: Response) => {
    const parsed = DeleteProjectBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendZodFailure(res, 'Invalid delete payload.', parsed.error.flatten());
      return;
    }
    const result = await deleteProject.execute({
      userId: req.user!.userId,
      projectId: paramString(req.params.id),
      ...(parsed.data.confirmationToken !== undefined
        ? { confirmationToken: parsed.data.confirmationToken }
        : {}),
    });
    if (!result.ok) {
      sendDomainError(res, result.error);
      return;
    }
    res.status(200).json({
      message: 'Project and all associated data deleted successfully.',
    });
  });

  // DELETE /projects/:id/pages/:pageId -----------------------------------
  router.delete('/:id/pages/:pageId', async (req: Request, res: Response) => {
    const rawMode = typeof req.query.onNonEmpty === 'string' ? req.query.onNonEmpty : 'block';
    if (rawMode !== 'block' && rawMode !== 'cascade') {
      res.status(400).json({
        error: 'Query parameter `onNonEmpty` must be `block` or `cascade`.',
      });
      return;
    }
    const result = await deletePage.execute({
      userId: req.user!.userId,
      projectId: paramString(req.params.id),
      pageId: paramString(req.params.pageId),
      onNonEmpty: rawMode,
    });
    if (!result.ok) {
      sendDomainError(res, result.error);
      return;
    }
    res.status(200).json({
      deleted: true,
      pageId: result.value.pageId,
      annotationCount: result.value.annotationCount,
    });
  });

  // GET /projects/:id/members --------------------------------------------
  router.get('/:id/members', async (req: Request, res: Response) => {
    const result = await listProjectMembers.execute({
      userId: req.user!.userId,
      projectId: paramString(req.params.id),
    });
    if (!result.ok) {
      sendDomainError(res, result.error);
      return;
    }
    res.status(200).json({
      members: result.value.members.map((m) => ({
        userId: m.userId,
        email: m.email,
        name: m.name,
        avatarUrl: m.avatarUrl,
        role: m.role,
      })),
    });
  });

  // GET /projects/:id/analytics ------------------------------------------
  router.get('/:id/analytics', async (req: Request, res: Response) => {
    const result = await computeAnalytics.execute({
      userId: req.user!.userId,
      projectId: paramString(req.params.id),
    });
    if (!result.ok) {
      sendDomainError(res, result.error);
      return;
    }
    res.status(200).json({ analytics: result.value });
  });

  // POST /projects/:id/export --------------------------------------------
  // Mounted under the same router so the URL surface (`/api/v1/projects/:id/export`)
  // matches the legacy router for binary parity. The composition root
  // mounts the full router at `/api/v1/projects`.
  router.post('/:id/export', async (req: Request, res: Response) => {
    const parsed = ExportBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendZodFailure(res, 'Invalid export payload.', parsed.error.flatten());
      return;
    }
    const result = await exportProjectReport.execute({
      userId: req.user!.userId,
      projectId: paramString(req.params.id),
      format: parsed.data.format,
    });
    if (!result.ok) {
      sendDomainError(res, result.error);
      return;
    }
    const rendered = result.value;
    res.setHeader('Content-Type', rendered.contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${rendered.filename}"`,
    );
    res.status(200).send(rendered.body);
  });

  return router;
}
