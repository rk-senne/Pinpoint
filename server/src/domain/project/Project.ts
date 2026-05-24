// Project entity (Phase 1.5 / task 4.6.1).

export type ProjectStatus = 'active' | 'archived';

export interface Project {
  id: string;
  name: string;
  urls: string[];
  status: ProjectStatus;
  ownerId: string;
  teamId?: string;
  createdAt: string;
  updatedAt: string;
}

/** Input shape for creating a new project; the repo assigns id + timestamps. */
export interface NewProject {
  name: string;
  urls: string[];
  ownerId: string;
  teamId?: string;
}

export interface ProjectPatch {
  name?: string;
  status?: ProjectStatus;
}
