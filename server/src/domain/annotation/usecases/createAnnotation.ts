// createAnnotation use case for the annotation-create flow. The use
// case owns the orchestration:
//   1. Project access check (owner or team member).
//   2. Offline-replay idempotency lookup by `(projectId, clientRequestId)`
//      — a hit returns the existing annotation untouched so the client
//      syncer can replay safely after a crash (Req 44.3 / Phase 22).
//   3. Atomic pin allocation via `ProjectPinSequence.next` and Page
//      lookup-or-create (Req 23.2, 24.1, 24.3) — both reach into the
//      same outbound transaction passed through `tx`.
//   4. Persist the annotation through `AnnotationRepo.insert`.
//   5. Emit `annotation.created` on the EventBus so the realtime adapter
//      broadcasts to room `project:<id>`.
//
// The `tx` handle is opaque (`unknown`) at the domain seam so this layer
// stays free of `knex` / `pg`. The Postgres adapter for
// `ProjectPinSequence` narrows it back to its native handle. Adapters
// that don't need a transaction (e.g., in-memory tests) accept any
// truthy value, including a sentinel.

import type { Annotation, NewAnnotation } from '../Annotation.js';
import type { AnnotationRepo } from '../ports/AnnotationRepo.js';
import type { ProjectPinSequence } from '../ports/ProjectPinSequence.js';
import type { PageRepo } from '../../project/ports/PageRepo.js';
import type { ProjectRepo } from '../../project/ports/ProjectRepo.js';
import type { TeamMemberRepo } from '../../team/ports/TeamMemberRepo.js';
import type { Clock } from '../../shared/ports/Clock.js';
import type { EventBus } from '../../shared/ports/EventBus.js';
import { hasProjectAccess } from '../../shared/projectAccess.js';
import {
  Forbidden,
  NotFound,
  type DomainError,
  type Result,
  err,
  ok,
} from '../../shared/DomainError.js';

/**
 * Function adapters wrap a database transaction at the inbound seam so the
 * domain layer can compose repo + pin-sequence operations atomically
 * without depending on knex types. Adapters pass a `tx` handle of their
 * own type into the callback; the use case forwards it to ports verbatim.
 */
export type TransactionRunner = <T>(
  fn: (tx: unknown) => Promise<T>,
) => Promise<T>;

export interface CreateAnnotationInput {
  projectId: string;
  authorUserId: string;
  pageUrl: string;
  type: NewAnnotation['type'];
  severity: NewAnnotation['severity'];
  body: string;
  target: NewAnnotation['target'];
  environment: NewAnnotation['environment'];
  orgId?: string;
  guidelineId?: string;
  capturedConsole?: NewAnnotation['capturedConsole'];
  capturedNetwork?: NewAnnotation['capturedNetwork'];
  /** UUID for offline-replay idempotency (Req 44.3). */
  clientRequestId?: string;
}

export interface CreateAnnotationOutput {
  annotation: Annotation;
  pageUrl: string;
  /** True when the row already existed and the call was treated as a replay. */
  idempotentReplay: boolean;
}

export interface CreateAnnotationDeps {
  annotationRepo: AnnotationRepo;
  projectRepo: ProjectRepo;
  pageRepo: PageRepo;
  teamMemberRepo: TeamMemberRepo;
  pinSequence: ProjectPinSequence;
  /** Wraps repo + pin-sequence calls in a single transaction. */
  runInTransaction: TransactionRunner;
  clock: Clock;
  eventBus: EventBus;
}

export class CreateAnnotation {
  constructor(private readonly deps: CreateAnnotationDeps) {}

  async execute(
    input: CreateAnnotationInput,
  ): Promise<Result<CreateAnnotationOutput, DomainError>> {
    const {
      annotationRepo,
      projectRepo,
      pageRepo,
      teamMemberRepo,
      pinSequence,
      runInTransaction,
      eventBus,
    } = this.deps;

    const project = await projectRepo.findById(input.projectId);
    if (!project) {
      return err(new NotFound('Project not found.'));
    }

    const hasAccess = await hasProjectAccess(
      teamMemberRepo,
      project.ownerId,
      project.teamId,
      input.authorUserId,
    );
    if (!hasAccess) {
      return err(new Forbidden('You do not have access to this project.'));
    }

    // Idempotent replay: returning the cached row before allocating a pin
    // keeps the project's pin counter monotonic on retry (Req 44.3).
    if (input.clientRequestId) {
      const existing = await annotationRepo.findByClientRequestId(
        input.projectId,
        input.clientRequestId,
      );
      if (existing) {
        const page = await pageRepo.findById(existing.pageId);
        return ok({
          annotation: existing,
          pageUrl: page?.url ?? '',
          idempotentReplay: true,
        });
      }
    }

    const trimmedUrl = input.pageUrl.trim();
    if (!trimmedUrl) {
      return err(new NotFound('Page URL is required.'));
    }
    const trimmedBody = input.body.trim();

    const created = await runInTransaction(async (tx) => {
      let page = await pageRepo.findByProjectAndUrl(input.projectId, trimmedUrl);
      if (!page) {
        page = await pageRepo.insert({
          projectId: input.projectId,
          url: trimmedUrl,
          title: null,
        });
      }

      const pinNumber = await pinSequence.next(input.projectId, tx);

      const inserted = await annotationRepo.insert({
        projectId: input.projectId,
        pageId: page.id,
        type: input.type,
        severity: input.severity,
        status: 'active',
        body: trimmedBody,
        authorId: input.authorUserId,
        target: input.target,
        environment: input.environment,
        pinNumber,
        orgId: input.orgId,
        guidelineId: input.guidelineId,
        capturedConsole: input.capturedConsole,
        capturedNetwork: input.capturedNetwork,
        clientRequestId: input.clientRequestId,
      });

      return { annotation: inserted, pageUrl: page.url };
    });

    eventBus.emit({
      type: 'annotation.created',
      room: `project:${input.projectId}`,
      payload: {
        ...created.annotation,
        pageUrl: created.pageUrl,
      },
    });

    return ok({
      annotation: created.annotation,
      pageUrl: created.pageUrl,
      idempotentReplay: false,
    });
  }
}
