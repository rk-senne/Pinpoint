import type { CreateUserNotification } from './userNotifications.js';
import type { UserNotificationRepo } from '../ports/UserNotificationRepo.js';

export interface NotificationTriggersDeps {
  createUserNotification: CreateUserNotification;
  userNotificationRepo: UserNotificationRepo;
}

export class NotificationTriggers {
  constructor(private readonly deps: NotificationTriggersDeps) {}

  async triggerMentionNotification(
    mentionedUserId: string,
    commentAuthorName: string,
    annotationId: string,
    orgId: string,
  ): Promise<void> {
    const prefs = await this.deps.userNotificationRepo.getPreferences(mentionedUserId, orgId);
    if (prefs && !prefs.mention) return;

    await this.deps.createUserNotification.execute({
      userId: mentionedUserId,
      orgId,
      type: 'mention',
      title: `${commentAuthorName} mentioned you in a comment`,
      metadata: { annotationId },
    });
  }

  async triggerStatusChangeNotification(
    annotationAuthorId: string,
    changerName: string,
    annotationId: string,
    newStatus: string,
    orgId: string,
  ): Promise<void> {
    const prefs = await this.deps.userNotificationRepo.getPreferences(annotationAuthorId, orgId);
    if (prefs && !prefs.statusChange) return;

    await this.deps.createUserNotification.execute({
      userId: annotationAuthorId,
      orgId,
      type: 'status_change',
      title: `${changerName} changed annotation status to ${newStatus}`,
      metadata: { annotationId, newStatus },
    });
  }

  async triggerCommentNotification(
    annotationAuthorId: string,
    commenterName: string,
    annotationId: string,
    orgId: string,
  ): Promise<void> {
    const prefs = await this.deps.userNotificationRepo.getPreferences(annotationAuthorId, orgId);
    if (prefs && !prefs.commentOnOwn) return;

    await this.deps.createUserNotification.execute({
      userId: annotationAuthorId,
      orgId,
      type: 'comment_on_own',
      title: `${commenterName} commented on your annotation`,
      metadata: { annotationId },
    });
  }
}
