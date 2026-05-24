// createSharedLink use case (Phase 1.5 / task 4.7.7).
//
// Owner-only management of the optionally-password-protected shared link
// for a project (Req 15.1, 15.2). When a link already exists the password
// is rotated and lockout counters reset; otherwise a new row is inserted.
// The returned `SharedLink` is the persisted entity; callers omit the
// password hash before sending to clients.

import { Forbidden, NotFound, err, ok } from '../../shared/DomainError.js';
import type { DomainError, Result } from '../../shared/DomainError.js';
import type { PasswordHasher } from '../../auth/ports/PasswordHasher.js';
import type { ProjectRepo } from '../../project/ports/ProjectRepo.js';
import type { SharedLink } from '../SharedLink.js';
import type { SharedLinkRepo } from '../ports/SharedLinkRepo.js';

export interface CreateSharedLinkInput {
  /** Caller's user id; must match the project owner. */
  userId: string;
  projectId: string;
  /** Optional plaintext password; falsy / empty creates an open link. */
  password?: string | null;
}

export interface CreateSharedLinkDeps {
  projectRepo: ProjectRepo;
  sharedLinkRepo: SharedLinkRepo;
  passwordHasher: PasswordHasher;
}

export class CreateSharedLink {
  constructor(private readonly deps: CreateSharedLinkDeps) {}

  async execute(
    input: CreateSharedLinkInput,
  ): Promise<Result<SharedLink, DomainError>> {
    const { projectRepo, sharedLinkRepo, passwordHasher } = this.deps;

    const project = await projectRepo.findById(input.projectId);
    if (!project) {
      return err(new NotFound('Project not found.'));
    }

    if (project.ownerId !== input.userId) {
      return err(
        new Forbidden('Only the project owner can manage shared links.'),
      );
    }

    const passwordHash =
      typeof input.password === 'string' && input.password.length > 0
        ? await passwordHasher.hash(input.password)
        : null;

    const existing = await sharedLinkRepo.findByProjectId(input.projectId);
    if (existing) {
      // Rotate the password and clear any active lockout (Req 15.3).
      const updated = await sharedLinkRepo.update(existing.id, {
        passwordHash,
        failedAttempts: 0,
        lockedUntil: null,
      });
      return ok(updated);
    }

    const created = await sharedLinkRepo.insert({
      projectId: input.projectId,
      passwordHash,
    });
    return ok(created);
  }
}
