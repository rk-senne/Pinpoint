// Realtime/webhook event emission for routes that write annotations
// directly (bulk actions, the feedback API) instead of going through the
// annotation use cases. Mirrors the event shapes of `updateAnnotation` and
// `changeAnnotationStatus` exactly so every subscriber (dashboard, extension,
// webhooks) sees the same events regardless of which route made the change.
//
// Emission is best-effort and runs AFTER the database write: a failure here
// must never turn an already-committed change into an error response.

import type { Knex } from 'knex';
import type { EventBus } from '../../../domain/shared/ports/EventBus.js';
import type { Annotation, AnnotationStatus } from '../../../domain/annotation/Annotation.js';

async function pageUrlOf(db: Knex, pageId: string): Promise<string | null> {
  const row = await db('pages').where({ id: pageId }).first('url');
  return (row?.url as string | undefined) ?? null;
}

/** `annotation.created` — same payload as the createAnnotation use case. */
export async function emitAnnotationCreated(
  eventBus: EventBus | undefined,
  db: Knex,
  annotation: Annotation,
): Promise<void> {
  if (!eventBus) return;
  try {
    eventBus.emit({
      type: 'annotation.created',
      room: `project:${annotation.projectId}`,
      payload: { ...annotation, pageUrl: await pageUrlOf(db, annotation.pageId) },
    });
  } catch {
    // best-effort
  }
}

/** `annotation.updated` — same payload as the updateAnnotation use case. */
export async function emitAnnotationUpdated(
  eventBus: EventBus | undefined,
  db: Knex,
  annotation: Annotation,
): Promise<void> {
  if (!eventBus) return;
  try {
    eventBus.emit({
      type: 'annotation.updated',
      room: `project:${annotation.projectId}`,
      payload: { ...annotation, pageUrl: await pageUrlOf(db, annotation.pageId) },
    });
  } catch {
    // best-effort
  }
}

/** `annotation.status_changed` — same payload as the changeAnnotationStatus use case. */
export async function emitAnnotationStatusChanged(
  eventBus: EventBus | undefined,
  db: Knex,
  annotation: Annotation,
  previousStatus: AnnotationStatus | string,
  changedBy: string,
): Promise<void> {
  if (!eventBus || previousStatus === annotation.status) return;
  try {
    eventBus.emit({
      type: 'annotation.status_changed',
      room: `project:${annotation.projectId}`,
      payload: {
        ...annotation,
        pageUrl: await pageUrlOf(db, annotation.pageId),
        previousStatus,
        changedBy,
      },
    });
  } catch {
    // best-effort
  }
}
