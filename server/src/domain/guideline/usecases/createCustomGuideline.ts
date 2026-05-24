// createCustomGuideline use case (Phase 1.5 / task 4.7.8).
//
// Authenticated users can author additional heuristics on top of the
// Nielsen defaults (Req 39.3). `name` and `description` are required and
// trimmed; `isDefault` is always false for user-authored entries.

import { Validation, err, ok } from '../../shared/DomainError.js';
import type { DomainError, Result } from '../../shared/DomainError.js';
import type { Guideline } from '../Guideline.js';
import type { GuidelineRepo } from '../ports/GuidelineRepo.js';

export interface CreateCustomGuidelineInput {
  /** Caller's user id; persisted as the creator. */
  userId: string;
  name: string;
  description: string;
}

export interface CreateCustomGuidelineDeps {
  guidelineRepo: GuidelineRepo;
}

export class CreateCustomGuideline {
  constructor(private readonly deps: CreateCustomGuidelineDeps) {}

  async execute(
    input: CreateCustomGuidelineInput,
  ): Promise<Result<Guideline, DomainError>> {
    const name = (input.name ?? '').trim();
    if (name.length === 0) {
      return err(new Validation('Guideline name is required.'));
    }

    const description = (input.description ?? '').trim();
    if (description.length === 0) {
      return err(new Validation('Guideline description is required.'));
    }

    const created = await this.deps.guidelineRepo.insert({
      name,
      description,
      isDefault: false,
      createdByUserId: input.userId,
    });
    return ok(created);
  }
}
