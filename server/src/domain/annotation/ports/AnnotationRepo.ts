// AnnotationRepo outbound port (Phase 1.5 / task 4.6.2).
//
// The repo is the single seam through which the annotation use cases
// reach durable storage.

import type {
  Annotation,
  AnnotationPatch,
  AnnotationStatus,
  NewAnnotation,
} from '../Annotation.js';

export interface ListAnnotationsFilter {
  status?: AnnotationStatus;
  /** DB-level pagination — maximum rows to return. */
  limit?: number;
  /** DB-level pagination — rows to skip. */
  offset?: number;
}

export interface PaginatedAnnotations {
  rows: Annotation[];
  total: number;
}

export interface AnnotationRepo {
  /** Insert a fully-formed annotation; pin number must already be allocated. */
  insert(input: NewAnnotation): Promise<Annotation>;

  /** Look up by primary key. Returns null when the row does not exist. */
  findById(id: string): Promise<Annotation | null>;

  /** Project-scoped list, ordered by pin number ascending. Supports optional limit/offset. */
  listByProject(
    projectId: string,
    filter?: ListAnnotationsFilter,
  ): Promise<Annotation[]>;

  /** Count annotations matching a filter (for pagination totals). */
  countByProject(
    projectId: string,
    filter?: Pick<ListAnnotationsFilter, 'status'>,
  ): Promise<number>;

  /** Apply a partial update; returns the updated row. */
  update(id: string, patch: AnnotationPatch): Promise<Annotation>;

  /** Hard delete; FK-cascading children (comments) follow per the schema. */
  delete(id: string): Promise<void>;

  /** Persist a screenshot object key after the upload completes. */
  setScreenshotKey(id: string, key: string): Promise<void>;

  /**
   * Idempotency lookup for offline replay (Req 44.3). Scoped by project so
   * two different projects can legitimately reuse the same client UUID.
   */
  findByClientRequestId(
    projectId: string,
    clientRequestId: string,
  ): Promise<Annotation | null>;
}
