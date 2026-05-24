// listGuidelines use case (Phase 1.5 / task 4.7.8).
//
// Returns the heuristic catalogue (Req 39.1 / 39.2). Defaults first, then
// custom guidelines alphabetical by name. The repo enforces ordering so
// the use case is a thin pass-through; it lives in the domain so future
// callers (e.g., a workspace-scoped variant) have a stable seam.

import { ok } from '../../shared/DomainError.js';
import type { DomainError, Result } from '../../shared/DomainError.js';
import type { Guideline } from '../Guideline.js';
import type { GuidelineRepo } from '../ports/GuidelineRepo.js';

export interface ListGuidelinesDeps {
  guidelineRepo: GuidelineRepo;
}

export class ListGuidelines {
  constructor(private readonly deps: ListGuidelinesDeps) {}

  async execute(): Promise<Result<Guideline[], DomainError>> {
    const guidelines = await this.deps.guidelineRepo.list();
    return ok(guidelines);
  }
}
