import type { UserNotification, UserNotificationType, NotificationPreferences } from '../UserNotification.js';

export interface NewUserNotification {
  userId: string;
  orgId: string;
  type: UserNotificationType;
  title: string;
  body?: string;
  metadata?: Record<string, unknown>;
}

export interface UserNotificationRepo {
  insert(n: NewUserNotification): Promise<UserNotification>;
  listByUser(userId: string, limit: number, offset: number): Promise<UserNotification[]>;
  countUnread(userId: string): Promise<number>;
  markRead(id: string, userId: string): Promise<void>;
  markAllRead(userId: string): Promise<void>;
  getPreferences(userId: string, orgId: string): Promise<NotificationPreferences | null>;
  upsertPreferences(prefs: NotificationPreferences): Promise<void>;
}
