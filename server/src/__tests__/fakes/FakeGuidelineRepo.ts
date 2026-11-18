// FakeGuidelineRepo — in-memory GuidelineRepo fake
// (Phase 1.5 / task 4.11.1).

import { randomUUID } from 'node:crypto';

import type {
  Guideline,
  NewGuideline,
} from '../../domain/guideline/Guideline.js';
import type { GuidelineRepo } from '../../domain/guideline/ports/GuidelineRepo.js';

export class FakeGuidelineRepo implements GuidelineRepo {
  /** Public for direct inspection in tests. */
  readonly guidelines = new Map<string, Guideline>();

  async insert(input: NewGuideline): Promise<Guideline> {
    const id = randomUUID();
    const guideline: Guideline = {
      id,
      name: input.name,
      description: input.description,
      isDefault: input.isDefault,
    };
    if (input.createdByUserId) guideline.createdByUserId = input.createdByUserId;
    if (!input.isDefault && input.orgId) guideline.orgId = input.orgId;
    this.guidelines.set(id, guideline);
    return { ...guideline };
  }

  async list(orgId: string): Promise<Guideline[]> {
    const all = Array.from(this.guidelines.values())
      .filter((g) => g.isDefault || g.orgId === orgId)
      .map((g) => ({ ...g }));
    all.sort((a, b) => {
      if (a.isDefault !== b.isDefault) {
        return a.isDefault ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
    return all;
  }

  async hasDefaults(): Promise<boolean> {
    for (const guideline of this.guidelines.values()) {
      if (guideline.isDefault) return true;
    }
    return false;
  }

  async insertMany(inputs: NewGuideline[]): Promise<void> {
    for (const input of inputs) {
      await this.insert(input);
    }
  }
}
