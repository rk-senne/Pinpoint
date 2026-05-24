// Postgres adapter for AnnotationRepo (Phase 1.5 / task 4.8.1).
//
// The only place outside the composition root where the `annotations` table
// is read or written. SQL semantics cover JSONB storage shape,
// capture-buffer round-tripping, and idempotency lookup.
//
// Transactions are deliberately NOT taken here: the create-annotation flow
// requires a single transaction across `pages` lookup, `projects.pin_counter`
// increment, and the annotation insert. That orchestration belongs to the
// use case (Phase 4.7) and the use case will pass `Knex.Transaction` handles
// through `ProjectPinSequence.next` / a future overload of `insert`. The
// current `insert` accepts a pre-allocated `pinNumber` so the use case can
// run the increment under the same transaction it uses for the insert.

import type { Knex } from 'knex';
import type {
  Annotation,
  AnnotationPatch,
  AnnotationStatus,
  CapturedConsoleEntry,
  CapturedNetworkEntry,
  NewAnnotation,
} from '../../../domain/annotation/Annotation.js';
import type { DOMTarget } from '../../../domain/annotation/DOMTarget.js';
import type { EnvironmentMetadata } from '../../../domain/annotation/EnvironmentMetadata.js';
import type {
  AnnotationRepo,
  ListAnnotationsFilter,
} from '../../../domain/annotation/ports/AnnotationRepo.js';

interface AnnotationRow {
  id: string;
  project_id: string;
  page_id: string;
  type: string;
  severity: string;
  status: string;
  body: string;
  author_id: string;
  target: unknown;
  environment: unknown;
  guideline_id: string | null;
  assignee_id: string | null;
  due_date: string | Date | null;
  pin_number: number;
  screenshot_object_key: string | null;
  captured_console: unknown;
  captured_network: unknown;
  client_request_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export class PgAnnotationRepo implements AnnotationRepo {
  constructor(private readonly db: Knex) {}

  async insert(input: NewAnnotation): Promise<Annotation> {
    const row: Record<string, unknown> = {
      project_id: input.projectId,
      page_id: input.pageId,
      type: input.type,
      severity: input.severity,
      status: input.status,
      body: input.body,
      author_id: input.authorId,
      target: JSON.stringify(input.target),
      environment: JSON.stringify(input.environment),
      pin_number: input.pinNumber,
    };

    if (input.guidelineId !== undefined) row.guideline_id = input.guidelineId;
    if (input.assigneeId !== undefined) row.assignee_id = input.assigneeId;
    if (input.dueDate !== undefined) row.due_date = input.dueDate;
    if (input.capturedConsole !== undefined) {
      row.captured_console =
        input.capturedConsole === null ? null : JSON.stringify(input.capturedConsole);
    }
    if (input.capturedNetwork !== undefined) {
      row.captured_network =
        input.capturedNetwork === null ? null : JSON.stringify(input.capturedNetwork);
    }
    if (input.clientRequestId !== undefined) row.client_request_id = input.clientRequestId;

    const [created] = await this.db<AnnotationRow>('annotations')
      .insert(row)
      .returning('*');
    return this.mapRow(created);
  }

  async findById(id: string): Promise<Annotation | null> {
    const row = await this.db<AnnotationRow>('annotations').where({ id }).first();
    return row ? this.mapRow(row) : null;
  }

  async listByProject(
    projectId: string,
    filter?: ListAnnotationsFilter,
  ): Promise<Annotation[]> {
    let query = this.db<AnnotationRow>('annotations').where({ project_id: projectId });
    if (filter?.status) {
      query = query.andWhere('status', filter.status as AnnotationStatus);
    }
    const rows = await query.orderBy('pin_number', 'asc');
    return rows.map((r) => this.mapRow(r));
  }

  async update(id: string, patch: AnnotationPatch): Promise<Annotation> {
    const updates: Record<string, unknown> = {};
    if (patch.body !== undefined) updates.body = patch.body;
    if (patch.severity !== undefined) updates.severity = patch.severity;
    if (patch.assigneeId !== undefined) updates.assignee_id = patch.assigneeId;
    if (patch.dueDate !== undefined) updates.due_date = patch.dueDate;
    if (patch.status !== undefined) updates.status = patch.status;

    const [updated] = await this.db<AnnotationRow>('annotations')
      .where({ id })
      .update(updates)
      .returning('*');
    return this.mapRow(updated);
  }

  async delete(id: string): Promise<void> {
    await this.db('annotations').where({ id }).del();
  }

  async setScreenshotKey(id: string, key: string): Promise<void> {
    await this.db('annotations').where({ id }).update({ screenshot_object_key: key });
  }

  async findByClientRequestId(
    projectId: string,
    clientRequestId: string,
  ): Promise<Annotation | null> {
    const row = await this.db<AnnotationRow>('annotations')
      .where({ project_id: projectId, client_request_id: clientRequestId })
      .first();
    return row ? this.mapRow(row) : null;
  }

  /**
   * Map a DB row to the domain entity. JSONB columns may be returned as
   * objects (pg driver) or strings (some test mocks); normalize both shapes
   * so callers don't have to.
   */
  private mapRow(row: AnnotationRow): Annotation {
    const target = parseJsonb<DOMTarget>(row.target) as DOMTarget;
    const environment = parseJsonb<EnvironmentMetadata>(row.environment) as EnvironmentMetadata;

    const result: Annotation = {
      id: row.id,
      projectId: row.project_id,
      pageId: row.page_id,
      type: row.type as Annotation['type'],
      severity: row.severity as Annotation['severity'],
      status: row.status as AnnotationStatus,
      body: row.body,
      authorId: row.author_id,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
      target,
      environment,
      pinNumber: row.pin_number,
    };

    if (row.guideline_id) result.guidelineId = row.guideline_id;
    if (row.assignee_id) result.assigneeId = row.assignee_id;
    if (row.due_date) result.dueDate = toIso(row.due_date);
    if (row.screenshot_object_key) result.screenshotObjectKey = row.screenshot_object_key;

    // Capture-buffer columns are nullable JSONB. Preserve `null` distinct
    // from `undefined`: `undefined` means the column was missing from the
    // SELECT projection, while `null` is the explicit "no captures" signal
    // round-tripped through JSONB.
    if (row.captured_console !== undefined) {
      result.capturedConsole =
        row.captured_console === null
          ? null
          : (parseJsonb<CapturedConsoleEntry[]>(row.captured_console) as CapturedConsoleEntry[]);
    }
    if (row.captured_network !== undefined) {
      result.capturedNetwork =
        row.captured_network === null
          ? null
          : (parseJsonb<CapturedNetworkEntry[]>(row.captured_network) as CapturedNetworkEntry[]);
    }
    if (row.client_request_id) result.clientRequestId = row.client_request_id;

    return result;
  }
}

function parseJsonb<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return value as T;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
