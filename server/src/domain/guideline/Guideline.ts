// Guideline entity (Phase 1.5 / task 4.6.1).

export interface Guideline {
  id: string;
  name: string;
  description: string;
  /** True for Nielsen's 10 heuristics seeded at boot. */
  isDefault: boolean;
  createdByUserId?: string;
  /** Owning org for custom guidelines; undefined/null for global defaults. */
  orgId?: string;
}

export interface NewGuideline {
  name: string;
  description: string;
  isDefault: boolean;
  createdByUserId?: string;
  orgId?: string;
}
