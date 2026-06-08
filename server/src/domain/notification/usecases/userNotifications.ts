import type { UserNotification, UserNotificationType } from '../UserNotification.js';
import type { UserNotificationRepo, NewUserNotification } from '../ports/UserNotificationRepo.js';
import type { EventBus } from '../../shared/ports/EventBus.js';
import { type DomainError, type Result, ok } from '../../shared/DomainError.js';

export interface CreateUserNotificationInput {
  userId: string;
  orgId: string;
  type: UserNotificationType;
  title: string;
  body?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateUserNotificationDeps {
  userNotificationRepo: UserNotificationRepo;
  eventBus: EventBus;
}

export class CreateUserNotification {
  constructor(private readonly deps: CreateUserNotificationDeps) {}

  async execute(input: CreateUserNotificationInput): Promise<Result<{ notification: UserNotification }, DomainError>> {
    const n = await this.deps.userNotificationRepo.insert(input as NewUserNotification);
    this.deps.eventBus.emit({
      type: 'notification.created',
      room: `user:${input.userId}`,
      payload: { notification: n },
    });
    return ok({ notification: n });
  }
}

export interface ListUserNotificationsInput {
  userId: string;
  limit?: number;
  offset?: number;
}

export interface ListUserNotificationsDeps {
  userNotificationRepo: UserNotificationRepo;
}

export class ListUserNotifications {
  constructor(private readonly deps: ListUserNotificationsDeps) {}

  async execute(input: ListUserNotificationsInput): Promise<Result<{ notifications: UserNotification[]; unreadCount: number }, DomainError>> {
    const limit = input.limit ?? 50;
    const offset = input.offset ?? 0;
    const [notifications, unreadCount] = await Promise.all([
      this.deps.userNotificationRepo.listByUser(input.userId, limit, offset),
      this.deps.userNotificationRepo.countUnread(input.userId),
    ]);
    return ok({ notifications, unreadCount });
  }
}

export interface MarkNotificationReadInput {
  id?: string;
  userId: string;
  all?: boolean;
}

export interface MarkNotificationReadDeps {
  userNotificationRepo: UserNotificationRepo;
}

export class MarkNotificationRead {
  constructor(private readonly deps: MarkNotificationReadDeps) {}

  async execute(input: MarkNotificationReadInput): Promise<Result<void, DomainError>> {
    if (input.all) {
      await this.deps.userNotificationRepo.markAllRead(input.userId);
    } else if (input.id) {
      await this.deps.userNotificationRepo.markRead(input.id, input.userId);
    }
    return ok(undefined);
  }
}
