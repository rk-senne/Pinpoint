// Feature: pinpoint-app, Property 1: Project search returns only matching projects
// **Validates: Requirements 2.3**
//
// Domain-layer property test for the `SearchProjects` use case
// (Phase 1.5 / task 4.11.3). Drives the use case through `FakeProjectRepo`
// + `FakeTeamMemberRepo` so the property holds independently of Express
// or Postgres.
//
// Invariant: for any project list the caller has access to and any
// search string `s`, let `t = s.trim().toLowerCase()`:
//   * if `t` is empty, every accessible project is returned;
//   * otherwise the returned set equals the subset of projects whose
//     name (lowercased) contains `t` as a substring.
// (mirrors the production contract in PgProjectRepo.search:
//  `if (input.search && input.search.trim().length > 0) LIKE %lower(search)%`).

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

import {
  FakeClock,
  FakeProjectRepo,
  FakeTeamMemberRepo,
} from '../../../__tests__/fakes/index.js';
import { SearchProjects } from '../usecases/searchProjects.js';

const arbProjectName = fc.string({ minLength: 0, maxLength: 50 });
const arbProjectList = fc.array(arbProjectName, {
  minLength: 0,
  maxLength: 30,
});
// Search may be any string (including blank/whitespace-only); the
// production `trim().length === 0` short-circuit is part of the
// contract under test.
const arbSearch = fc.string({ minLength: 0, maxLength: 20 });

describe('Property 1: Project search returns only matching projects (use-case layer)', () => {
  it('SearchProjects returns exactly the projects whose names match the trimmed/lowercased search (or all of them when the search is blank)', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbProjectList,
        arbSearch,
        async (names, search) => {
          const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
          const teamMemberRepo = new FakeTeamMemberRepo({ clock });
          const projectRepo = new FakeProjectRepo({ clock, teamMemberRepo });

          const ownerId = 'owner-prop1';
          for (const name of names) {
            // Advance the clock so each project gets a unique
            // `updatedAt`; the fake's `search` orders by that field
            // descending, but ordering is irrelevant to the substring
            // invariant we are asserting here.
            clock.advance(1_000);
            await projectRepo.insert({
              name,
              urls: ['https://example.com'],
              ownerId,
            });
          }

          const usecase = new SearchProjects({ projectRepo });
          const result = await usecase.execute({ userId: ownerId, search });

          expect(result.ok).toBe(true);
          if (!result.ok) return;

          // Production contract: trim + lowercase, skip the LIKE filter
          // entirely when the trimmed needle is empty.
          const needle = search.trim().toLowerCase();

          if (needle.length === 0) {
            // (1) Blank search returns every accessible project.
            const expectedNames = [...names].sort();
            const actualNames = result.value.projects
              .map((p) => p.name)
              .sort();
            expect(actualNames).toEqual(expectedNames);
            return;
          }

          // (2) No false positives — every returned name contains the
          //     trimmed search string as a case-insensitive substring.
          for (const project of result.value.projects) {
            expect(project.name.toLowerCase()).toContain(needle);
          }

          // (3) No false negatives — every seeded name that matches is
          //     present in the result, and the multiset sizes match.
          const expectedNames = names
            .filter((n) => n.toLowerCase().includes(needle))
            .sort();
          const actualNames = result.value.projects
            .map((p) => p.name)
            .sort();
          expect(actualNames).toEqual(expectedNames);
        },
      ),
      { numRuns: 50 },
    );
  });
});
