// Shared project-access predicates.
//
// Project authorization gates the same two questions across every use
// case that touches a project, an annotation, a page, or a comment:
//
//   1. Can this user *see* the project? (`hasProjectAccess`)
//   2. Can this user *administer* the project? (`hasProjectAdminAccess`)
//
// Both predicates collapse the previous per-use-case copies (Reqs 22 /
// 23) so the access policy lives in exactly one place.

import type { TeamMemberRepo } from '../team/ports/TeamMemberRepo.js';

/**
 * Project access predicate (Req 22 / 23): the project owner has access,
 * and so does any member of the project's team. Used by every use case
 * that gates a read or write on project membership.
 */
export async function hasProjectAccess(
  teamMemberRepo: TeamMemberRepo,
  ownerId: string,
  teamId: string | undefined,
  userId: string,
): Promise<boolean> {
  if (ownerId === userId) return true;
  if (!teamId) return false;
  const membership = await teamMemberRepo.findByTeamAndUser(teamId, userId);
  return membership !== null;
}

/**
 * Strict project access predicate: only the project owner or a team admin
 * may proceed. Used by archive / delete-page / other admin-only mutations.
 */
export async function hasProjectAdminAccess(
  teamMemberRepo: TeamMemberRepo,
  ownerId: string,
  teamId: string | undefined,
  userId: string,
): Promise<boolean> {
  if (ownerId === userId) return true;
  if (!teamId) return false;
  const membership = await teamMemberRepo.findByTeamAndUser(teamId, userId);
  if (!membership) return false;
  return membership.role === 'owner' || membership.role === 'admin';
}
