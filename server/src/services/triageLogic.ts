/**
 * triageLogic — pure, deterministic heuristics for AI-assisted feedback triage.
 *
 * This module intentionally has **no database or I/O dependency**. Every
 * function is a pure function of its inputs so the behaviour can be exercised
 * by fast unit + property tests, and so the same logic can be reused by the
 * HTTP triage service, a future client-side "instant triage" surface, or an
 * offline batch job without dragging a Knex handle along.
 *
 * The heuristics are consciously simple keyword/similarity rules — the market
 * frontier (BugHerd AI, Usersnap AI, Zonka) layers an LLM on top, but a
 * transparent, self-hostable, zero-cost baseline is valuable on its own and
 * gives the product an AI-triage surface without an external API dependency.
 * Swapping in an LLM later is a matter of replacing the ranking inputs, not
 * the endpoint contract.
 */
import type { Severity } from '@pinpoint/shared';

/** A candidate annotation considered for duplicate detection. */
export interface DuplicateCandidate {
  id: string;
  body: string;
  pinNumber: number;
}

/** A ranked duplicate match returned to the caller. */
export interface DuplicateMatch {
  id: string;
  body: string;
  pinNumber: number;
  /** Trigram Jaccard similarity in the closed interval [0, 1]. */
  similarity: number;
}

/** Options controlling duplicate ranking. */
export interface RankDuplicatesOptions {
  /** Minimum similarity (exclusive) for a candidate to be reported. Default 0.6. */
  threshold?: number;
  /** Maximum number of matches to return. Default 3. */
  limit?: number;
  /** Candidate id to exclude (e.g. the annotation being triaged itself). */
  excludeId?: string;
}

/**
 * Ordered severity tiers. The first tier (scanned high → low) whose keyword
 * set matches the feedback body wins. Word-ish boundaries keep "error" from
 * matching inside "terrorform" while still catching "500 error".
 */
const SEVERITY_RULES: ReadonlyArray<{ severity: Severity; pattern: RegExp }> = [
  {
    severity: 'critical',
    pattern:
      /\b(crash(?:e[ds])?|broken|500|error|exception|fatal|blank\s*(?:page|screen)|unresponsive|data\s*loss|can'?t|cannot|unable|does\s*not\s*work|doesn'?t\s*work|not\s*working|fail(?:s|ed|ure)?|security|vulnerab)/i,
  },
  {
    severity: 'major',
    pattern:
      /\b(wrong|incorrect|misalign(?:ed|ment)?|overflow|cut\s*off|missing|broken\s*layout|not\s*aligned|out\s*of\s*place|overlap(?:s|ping)?|truncat)/i,
  },
  {
    severity: 'minor',
    pattern:
      /\b(typo|spacing|colou?r|font|padding|margin|alignment|capitaliz|spelling|minor|cosmetic)/i,
  },
];

/**
 * Classify the likely severity of a piece of feedback from its text.
 * Deterministic: returns the highest-priority tier with a keyword hit, or
 * `'informational'` when nothing matches.
 */
export function classifySeverity(body: string): Severity {
  const text = (body ?? '').toLowerCase();
  for (const rule of SEVERITY_RULES) {
    if (rule.pattern.test(text)) return rule.severity;
  }
  return 'informational';
}

/**
 * Auto-tag rules. Each tag is emitted at most once, and the result is sorted
 * for stable, order-independent output.
 */
const TAG_RULES: ReadonlyArray<{ tag: string; pattern: RegExp }> = [
  { tag: 'mobile', pattern: /\b(mobile|responsive|viewport|phone|tablet|touch)\b/i },
  { tag: 'performance', pattern: /\b(performance|slow|lag(?:gy|s|ging)?|load(?:ing|s)?|latency|freeze|jank)\b/i },
  { tag: 'design', pattern: /\b(design|ui|ux|visual|layout|style|alignment|colou?r|spacing)\b/i },
  { tag: 'copy', pattern: /\b(copy|text|wording|typo|spelling|grammar|label|content)\b/i },
  { tag: 'accessibility', pattern: /\b(accessibility|a11y|screen\s*reader|contrast|aria|keyboard\s*nav)\b/i },
  { tag: 'security', pattern: /\b(security|xss|csrf|injection|vulnerab|leak|exposed|auth)\b/i },
];

/**
 * Suggest zero or more topical tags for a piece of feedback. Returns a sorted,
 * de-duplicated array so callers get deterministic output.
 */
export function suggestTags(body: string): string[] {
  const text = (body ?? '').toLowerCase();
  const tags = new Set<string>();
  for (const rule of TAG_RULES) {
    if (rule.pattern.test(text)) tags.add(rule.tag);
  }
  return [...tags].sort();
}

/** Collapse whitespace and lowercase so similarity ignores formatting noise. */
function normalize(s: string): string {
  return (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Return the set of character trigrams for a normalized string. */
export function trigrams(s: string): Set<string> {
  const norm = normalize(s);
  const out = new Set<string>();
  for (let i = 0; i + 3 <= norm.length; i++) {
    out.add(norm.slice(i, i + 3));
  }
  return out;
}

/**
 * Character-trigram Jaccard similarity in the closed interval [0, 1].
 *
 * Properties (verified by tests):
 *  - Bounded: always 0 ≤ s ≤ 1.
 *  - Symmetric: sim(a, b) === sim(b, a).
 *  - Reflexive on equal, non-empty input: sim(x, x) === 1.
 *  - Two normalized-equal strings score 1 even when shorter than 3 chars
 *    (special-cased so identical short strings aren't reported as 0).
 */
export function jaccardSimilarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return na.length === 0 ? 0 : 1;

  const ta = trigrams(na);
  const tb = trigrams(nb);
  if (ta.size === 0 && tb.size === 0) return 0;

  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection++;
  const union = ta.size + tb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Rank candidate annotations by similarity to `body`, returning only those
 * above `threshold`, highest first, capped at `limit`. Similarity is rounded
 * to 3 decimals for stable output. Pure: does not mutate `candidates`.
 */
export function rankDuplicates(
  body: string,
  candidates: readonly DuplicateCandidate[],
  options: RankDuplicatesOptions = {},
): DuplicateMatch[] {
  const { threshold = 0.6, limit = 3, excludeId } = options;

  return candidates
    .filter((c) => c.id !== excludeId)
    .map((c) => ({
      id: c.id,
      body: c.body,
      pinNumber: c.pinNumber,
      similarity: Math.round(jaccardSimilarity(body, c.body) * 1000) / 1000,
    }))
    .filter((m) => m.similarity > threshold)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, Math.max(0, limit));
}
