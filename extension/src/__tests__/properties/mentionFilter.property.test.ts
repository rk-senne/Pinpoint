/**
 * Feature: pinpoint-app, Property 2: Mention autocomplete returns only matching members
 *
 * For any list of team members and any prefix string typed after "@", the
 * autocomplete dropdown shall return only members whose names or emails contain
 * the prefix as a case-insensitive substring, and no matching member shall be excluded.
 *
 * **Validates: Requirements 3.3, 12.3**
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { filterMentionCandidates, type MentionCandidate } from '../../lib/mentionFilter';

/** Arbitrary for a MentionCandidate */
const arbMentionCandidate: fc.Arbitrary<MentionCandidate> = fc.record({
  userId: fc.uuid(),
  name: fc.string({ minLength: 1, maxLength: 30 }),
  email: fc.emailAddress(),
});

describe('Property 2: Mention autocomplete returns only matching members', () => {
  it('returns only members whose name or email contains the query (case-insensitive)', () => {
    fc.assert(
      fc.property(
        fc.array(arbMentionCandidate, { minLength: 0, maxLength: 20 }),
        fc.string({ minLength: 0, maxLength: 15 }),
        (members, query) => {
          const result = filterMentionCandidates(members, query);
          const lowerQuery = query.toLowerCase();

          // Every returned member must match
          for (const m of result) {
            const nameMatch = m.name.toLowerCase().includes(lowerQuery);
            const emailMatch = m.email.toLowerCase().includes(lowerQuery);
            expect(nameMatch || emailMatch).toBe(true);
          }

          // No matching member is excluded
          for (const m of members) {
            const nameMatch = m.name.toLowerCase().includes(lowerQuery);
            const emailMatch = m.email.toLowerCase().includes(lowerQuery);
            if (nameMatch || emailMatch) {
              expect(result).toContainEqual(m);
            }
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('returns all members when query is empty', () => {
    fc.assert(
      fc.property(
        fc.array(arbMentionCandidate, { minLength: 0, maxLength: 20 }),
        (members) => {
          const result = filterMentionCandidates(members, '');
          expect(result).toEqual(members);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('result is a subset of the input members', () => {
    fc.assert(
      fc.property(
        fc.array(arbMentionCandidate, { minLength: 0, maxLength: 20 }),
        fc.string({ minLength: 1, maxLength: 10 }),
        (members, query) => {
          const result = filterMentionCandidates(members, query);
          expect(result.length).toBeLessThanOrEqual(members.length);
          for (const m of result) {
            expect(members).toContainEqual(m);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
