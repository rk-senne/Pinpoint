// FakeAnnotationRepo — in-memory AnnotationRepo fake
// (Phase 1.5 / task 4.11.1).
//
// Stores annotations by id. `listByProject` orders by `pinNumber`
// ascending to match the production adapter, and `findByClientRequestId`
// is scoped per project so the same UUID can legitimately exist in two
// different projects (mirrors Req 44.3 idempotency semantics).

import { randomUUID } from 'node:crypto';

import type {
  Annotation,
  AnnotationPatch,
  NewAnnotation,
} from '../../domain/annotation/Annotation.js';
import type {
  AnnotationRepo,
  ListAnnotationsFilter,
} from '../../domain/annotation/ports/AnnotationRepo.js';
import type { Clock } from '../../domain/shared/ports/Clock.js';

export class FakeAnnotationRepo implements AnnotationRepo {
  /** Public for direct inspection in tests. */
  readonly annotations = new Map<string, Annotation>();

  constructor(private readonly clock: Clock) {}

  async insert(input: NewAnnotation): Promise<Annotation> {
    const id = randomUUID();
    const now = this.clock.now().toISOString();
    const annotation: Annotation = {
      id,
      projectId: input.projectId,
      pageId: input.pageId,
      type: input.type,
      severity: input.severity,
      status: input.status,
      body: input.body,
      authorId: input.authorId,
      target: { ...input.target },
      environment: { ...input.environment },
      pinNumber: input.pinNumber,
      createdAt: now,
      updatedAt: now,
    };
    if (input.guidelineId !== undefined) annotation.guidelineId = input.guidelineId;
    if (input.assigneeId !== undefined) annotation.assigneeId = input.assigneeId;
    if (input.dueDate !== undefined) annotation.dueDate = input.dueDate;
    if (input.capturedConsole !== undefined) {
      annotation.capturedConsole =
        input.capturedConsole === null ? null : [...input.capturedConsole];
    }
    if (input.capturedNetwork !== undefined) {
      annotation.capturedNetwork =
        input.capturedNetwork === null ? null : [...input.capturedNetwork];
    }
    if (input.clientRequestId !== undefined) {
      annotation.clientRequestId = input.clientRequestId;
    }
    this.annotations.set(id, annotation);
    return clone(annotation);
  }

  async findById(id: string): Promise<Annotation | null> {
    const row = this.annotations.get(id);
    return row ? clone(row) : null;
  }

  async listByProject(
    projectId: string,
    filter?: ListAnnotationsFilter,
  ): Promise<Annotation[]> {
    const matches: Annotation[] = [];
    for (const row of this.annotations.values()) {
      if (row.projectId !== projectId) continue;
      if (filter?.status && row.status !== filter.status) continue;
      matches.push(clone(row));
    }
    matches.sort((a, b) => a.pinNumber - b.pinNumber);
    return matches;
  }

  async update(id: string, patch: AnnotationPatch): Promise<Annotation> {
    const row = this.annotations.get(id);
    if (!row) {
      throw new Error(`FakeAnnotationRepo.update: annotation ${id} not found`);
    }

    const next: Annotation = {
      ...row,
      target: { ...row.target },
      environment: { ...row.environment },
      updatedAt: this.clock.now().toISOString(),
    };
    if (patch.body !== undefined) next.body = patch.body;
    if (patch.severity !== undefined) next.severity = patch.severity;
    if (patch.status !== undefined) next.status = patch.status;
    if (patch.assigneeId !== undefined) {
      if (patch.assigneeId === null) {
        delete next.assigneeId;
      } else {
        next.assigneeId = patch.assigneeId;
      }
    }
    if (patch.dueDate !== undefined) {
      if (patch.dueDate === null) {
        delete next.dueDate;
      } else {
        next.dueDate = patch.dueDate;
      }
    }
    this.annotations.set(id, next);
    return clone(next);
  }

  async delete(id: string): Promise<void> {
    this.annotations.delete(id);
  }

  async setScreenshotKey(id: string, key: string): Promise<void> {
    const row = this.annotations.get(id);
    if (!row) return;
    this.annotations.set(id, {
      ...row,
      target: { ...row.target },
      environment: { ...row.environment },
      screenshotObjectKey: key,
      updatedAt: this.clock.now().toISOString(),
    });
  }

  async findByClientRequestId(
    projectId: string,
    clientRequestId: string,
  ): Promise<Annotation | null> {
    for (const row of this.annotations.values()) {
      if (row.projectId !== projectId) continue;
      if (row.clientRequestId !== clientRequestId) continue;
      return clone(row);
    }
    return null;
  }
}

function clone(a: Annotation): Annotation {
  const copy: Annotation = {
    ...a,
    target: { ...a.target },
    environment: { ...a.environment },
  };
  if (a.capturedConsole !== undefined) {
    copy.capturedConsole =
      a.capturedConsole === null ? null : a.capturedConsole.map((e) => ({ ...e }));
  }
  if (a.capturedNetwork !== undefined) {
    copy.capturedNetwork =
      a.capturedNetwork === null ? null : a.capturedNetwork.map((e) => ({ ...e }));
  }
  return copy;
}
