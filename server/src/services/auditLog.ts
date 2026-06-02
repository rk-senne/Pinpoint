import type { Knex } from 'knex';

export interface AuditEntry {
  orgId: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
}

export class AuditLog {
  constructor(private readonly db: Knex) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.db('audit_logs').insert({
      org_id: entry.orgId,
      actor_id: entry.actorId,
      action: entry.action,
      resource_type: entry.resourceType,
      resource_id: entry.resourceId ?? null,
      metadata: JSON.stringify(entry.metadata ?? {}),
      ip_address: entry.ipAddress ?? null,
    });
  }

  async listByOrg(orgId: string, limit = 50, offset = 0) {
    return this.db('audit_logs')
      .where({ org_id: orgId })
      .orderBy('created_at', 'desc')
      .limit(limit)
      .offset(offset);
  }
}
