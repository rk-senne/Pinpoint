import type { Knex } from 'knex';
import type { UserNotification, NotificationPreferences } from '../../../domain/notification/UserNotification.js';
import type { UserNotificationRepo, NewUserNotification } from '../../../domain/notification/ports/UserNotificationRepo.js';

export class PgUserNotificationRepo implements UserNotificationRepo {
  constructor(private readonly db: Knex) {}

  async insert(n: NewUserNotification): Promise<UserNotification> {
    const [row] = await this.db('user_notifications').insert({
      user_id: n.userId,
      org_id: n.orgId,
      type: n.type,
      title: n.title,
      body: n.body ?? null,
      metadata: JSON.stringify(n.metadata ?? {}),
    }).returning('*');
    return this.map(row);
  }

  async listByUser(userId: string, limit: number, offset: number): Promise<UserNotification[]> {
    const rows = await this.db('user_notifications')
      .where({ user_id: userId })
      .orderBy('created_at', 'desc')
      .limit(limit)
      .offset(offset);
    return rows.map((r: any) => this.map(r));
  }

  async countUnread(userId: string): Promise<number> {
    const [{ count }] = await this.db('user_notifications')
      .where({ user_id: userId, read: false })
      .count('* as count');
    return Number(count);
  }

  async markRead(id: string, userId: string): Promise<void> {
    await this.db('user_notifications').where({ id, user_id: userId }).update({ read: true });
  }

  async markAllRead(userId: string): Promise<void> {
    await this.db('user_notifications').where({ user_id: userId, read: false }).update({ read: true });
  }

  async getPreferences(userId: string, orgId: string): Promise<NotificationPreferences | null> {
    const row = await this.db('notification_preferences').where({ user_id: userId, org_id: orgId }).first();
    return row ? this.mapPrefs(row) : null;
  }

  async upsertPreferences(prefs: NotificationPreferences): Promise<void> {
    await this.db('notification_preferences')
      .insert({
        user_id: prefs.userId,
        org_id: prefs.orgId,
        mention: prefs.mention,
        comment_on_own: prefs.commentOnOwn,
        status_change: prefs.statusChange,
        project_activity: prefs.projectActivity,
      })
      .onConflict(['user_id', 'org_id'])
      .merge({
        mention: prefs.mention,
        comment_on_own: prefs.commentOnOwn,
        status_change: prefs.statusChange,
        project_activity: prefs.projectActivity,
      });
  }

  private map(row: any): UserNotification {
    return {
      id: row.id,
      userId: row.user_id,
      orgId: row.org_id,
      type: row.type,
      title: row.title,
      body: row.body ?? undefined,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata ?? {}),
      read: row.read,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    };
  }

  private mapPrefs(row: any): NotificationPreferences {
    return {
      userId: row.user_id,
      orgId: row.org_id,
      mention: row.mention,
      commentOnOwn: row.comment_on_own,
      statusChange: row.status_change,
      projectActivity: row.project_activity,
    };
  }
}
