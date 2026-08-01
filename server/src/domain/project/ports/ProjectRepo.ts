// ProjectRepo outbound port (Phase 1.5 / task 4.6.2).

import type { NewProject, Project, ProjectPatch } from '../Project.js';

export interface ProjectMember {
  userId: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: 'owner' | 'admin' | 'viewer';
  joinedAt?: string;
}

export interface SearchProjectsInput {
  /** Caller's user id; access is owner or team-member. */
  userId: string;
  search?: string;
  status?: 'active' | 'archived';
  limit?: number;
  offset?: number;
}

export interface ProjectRepo {
  insert(input: NewProject): Promise<Project>;
  findById(id: string): Promise<Project | null>;
  /** Owner + team membership scoped list with optional search/status filter. */
  search(input: SearchProjectsInput): Promise<Project[]>;
  /** Count projects matching search criteria (for pagination totals). */
  countSearch(input: Omit<SearchProjectsInput, 'limit' | 'offset'>): Promise<number>;
  update(id: string, patch: ProjectPatch): Promise<Project>;
  delete(id: string): Promise<void>;

  /** Count annotations attached to a project (analytics + GET /:id payload). */
  countAnnotations(projectId: string): Promise<number>;

  /** Members of the project: team members + owner (deduplicated, owner first). */
  listMembers(projectId: string): Promise<ProjectMember[]>;
}
