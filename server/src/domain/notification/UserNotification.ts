export type UserNotificationType =
  | 'mention'
  | 'comment_on_own'
  | 'status_change'
  | 'project_activity';

export interface UserNotification {
  id: string;
  userId: string;
  orgId: string;
  type: UserNotificationType;
  title: string;
  body?: string;
  metadata: Record<string, unknown>;
  read: boolean;
  createdAt: string;
}

export interface NotificationPreferences {
  userId: string;
  orgId: string;
  mention: boolean;
  commentOnOwn: boolean;
  statusChange: boolean;
  projectActivity: boolean;
}
