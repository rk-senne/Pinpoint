// User entity (Phase 1.5 / task 4.6.1).

export interface NotificationPreferences {
  newAnnotation: boolean;
  newComment: boolean;
  promotedToOwner: boolean;
  projectDeleted: boolean;
}

export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string;
  notificationPreferences: NotificationPreferences;
  createdAt: string;
}

/** Input shape for `registerUser`; the repo assigns id + timestamps. */
export interface NewUser {
  email: string;
  name: string;
  passwordHash: string;
  /** New users start unverified per Req 20.1. */
  verified?: boolean;
}

export interface UserPatch {
  name?: string;
  email?: string;
  avatarUrl?: string | null;
  notificationPreferences?: Partial<NotificationPreferences>;
  passwordHash?: string;
  verified?: boolean;
}
