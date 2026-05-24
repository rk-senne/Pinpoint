// GuidelineRepo outbound port (Phase 1.5 / task 4.6.2).

import type { Guideline, NewGuideline } from '../Guideline.js';

export interface GuidelineRepo {
  insert(input: NewGuideline): Promise<Guideline>;
  /** Defaults first, then alphabetical by name. */
  list(): Promise<Guideline[]>;
  /** Are the Nielsen defaults already seeded? */
  hasDefaults(): Promise<boolean>;
  /** Bulk insert used by the seeder when `hasDefaults()` returns false. */
  insertMany(inputs: NewGuideline[]): Promise<void>;
}
