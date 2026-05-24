// Postgres adapter for ProjectPinSequence (Phase 1.5 / task 4.8.1).
//
// Atomic per-project pin allocator (Req 24). The contract is:
//   `next(projectId, tx)` runs `UPDATE projects SET pin_counter = pin_counter + 1
//    WHERE id = ? RETURNING pin_counter` inside the supplied transaction so
//   concurrent inserts on the same project serialize on the row lock and
//   every issued pin number is distinct.
//
// `tx` is typed as `unknown` on the port to keep the domain layer free of
// knex types; here we narrow to `Knex.Transaction`. The caller (the
// create-annotation use case) is responsible for opening the transaction
// and using the same handle for both `next()` and the annotation insert.

import type { Knex } from 'knex';
import type { ProjectPinSequence } from '../../../domain/annotation/ports/ProjectPinSequence.js';

interface PinCounterRow {
  pin_counter: number;
}

export class PgProjectPinSequence implements ProjectPinSequence {
  // eslint-disable-next-line no-unused-vars
  constructor(_db: Knex) {
    // The base `db` is accepted for symmetry with the other adapters even
    // though `next` only ever uses the transaction handle the caller passes
    // in. Keeping the constructor signature consistent makes wiring at the
    // composition root uniform across repos.
  }

  async next(projectId: string, tx: unknown): Promise<number> {
    const trx = tx as Knex.Transaction;
    const rows = await trx<PinCounterRow>('projects')
      .where({ id: projectId })
      .increment('pin_counter', 1)
      .returning<PinCounterRow[]>('pin_counter');

    const first = rows[0];
    if (!first) {
      throw new Error(`PgProjectPinSequence.next: project ${projectId} not found`);
    }
    // Some Knex versions return `[{ pin_counter }]`, others `[number]` when
    // a single column is selected. Handle both.
    const value = (first as PinCounterRow & number).pin_counter ?? (first as unknown as number);
    return Number(value);
  }
}
