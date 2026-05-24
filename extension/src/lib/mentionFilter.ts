/**
 * Pure function: filter mention candidates by case-insensitive name/email prefix match.
 * Used by MentionAutocomplete and tested via property-based tests.
 */

export interface MentionCandidate {
  userId: string;
  name: string;
  email: string;
}

/**
 * Filter team members whose name or email contains the query as a
 * case-insensitive substring. Returns only matching members; no matching
 * member is excluded.
 */
export function filterMentionCandidates(
  members: MentionCandidate[],
  query: string
): MentionCandidate[] {
  if (!query) return members;
  const lowerQuery = query.toLowerCase();
  return members.filter(
    (m) =>
      m.name.toLowerCase().includes(lowerQuery) ||
      m.email.toLowerCase().includes(lowerQuery)
  );
}
