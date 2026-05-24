// ProjectPinSequence outbound port (Phase 1.5 / task 4.6.2).
//
// Atomic per-project pin number generator (Req 24). The Postgres adapter
// implements this by `UPDATE projects SET pin_counter = pin_counter + 1
// RETURNING pin_counter` inside the same transaction as the annotation
// insert, so concurrent inserts serialize on the project row lock and
// every issued pin number is distinct.
//
// `tx` is intentionally `unknown` here so the domain layer does not depend
// on the knex `Knex.Transaction` type. The Postgres adapter narrows back
// to its native handle.

export interface ProjectPinSequence {
  next(projectId: string, tx: unknown): Promise<number>;
}
