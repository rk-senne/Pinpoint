/**
 * Compact analytics summary used by the mobile project view: one chip per
 * headline number instead of four stacked breakdown cards.
 */

export interface SummarySource {
  total: number;
  bySeverity: Partial<Record<'critical' | 'major' | 'minor' | 'informational', number>>;
  byStatus: Partial<Record<'active' | 'in_progress' | 'resolved', number>>;
}

export interface SummaryChip {
  label: string;
  tone?: 'critical';
}

/** Chips for the headline numbers; zero buckets are omitted (except the total). */
export function summarizeAnalytics(a: SummarySource): SummaryChip[] {
  const chips: SummaryChip[] = [{ label: `${a.total} ${a.total === 1 ? 'annotation' : 'annotations'}` }];
  const critical = a.bySeverity.critical ?? 0;
  if (critical > 0) chips.push({ label: `${critical} critical`, tone: 'critical' });
  const open = a.byStatus.active ?? 0;
  const progress = a.byStatus.in_progress ?? 0;
  const resolved = a.byStatus.resolved ?? 0;
  if (open > 0) chips.push({ label: `${open} open` });
  if (progress > 0) chips.push({ label: `${progress} in progress` });
  if (resolved > 0) chips.push({ label: `${resolved} resolved` });
  return chips;
}
