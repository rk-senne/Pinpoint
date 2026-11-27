// Postgres adapter for MfaRepo. The TOTP secret is encrypted at rest with the
// same SecretBox (AES-256-GCM) as integration tokens and webhook secrets.

import type { Knex } from 'knex';
import type { MfaRecord, MfaRepo } from '../../../domain/auth/mfa/MfaRepo.js';
import type { SecretBox } from '../../../services/secretBox.js';

interface Row {
  user_id: string;
  secret_enc: string;
  enabled: boolean;
  last_step: string | number | null;
  failed_attempts: number;
  locked_until: Date | string | null;
}

export class PgMfaRepo implements MfaRepo {
  constructor(
    private readonly db: Knex,
    private readonly box: SecretBox,
  ) {}

  async find(userId: string): Promise<MfaRecord | null> {
    const row = await this.db<Row>('user_mfa').where({ user_id: userId }).first();
    if (!row) return null;
    return {
      userId: row.user_id,
      secret: this.box.decrypt(row.secret_enc),
      enabled: row.enabled,
      lastStep: row.last_step === null ? null : Number(row.last_step),
      failedAttempts: row.failed_attempts,
      lockedUntil: row.locked_until ? new Date(row.locked_until) : null,
    };
  }

  async upsertPending(userId: string, secret: string): Promise<boolean> {
    const enc = this.box.encrypt(secret);
    const res = await this.db.raw(
      `INSERT INTO user_mfa (user_id, secret_enc, enabled) VALUES (?, ?, false)
       ON CONFLICT (user_id) DO UPDATE
         SET secret_enc = EXCLUDED.secret_enc, last_step = NULL, failed_attempts = 0, locked_until = NULL, created_at = now()
         WHERE user_mfa.enabled = false`,
      [userId, enc],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async enable(userId: string, lastStep: number, recoveryHashes: string[]): Promise<boolean> {
    return this.db.transaction(async (trx) => {
      const n = await trx('user_mfa')
        .where({ user_id: userId, enabled: false })
        .update({ enabled: true, enabled_at: trx.fn.now(), last_step: lastStep, failed_attempts: 0, locked_until: null });
      if (n === 0) return false;
      await trx('user_recovery_codes').where({ user_id: userId }).del();
      if (recoveryHashes.length) {
        await trx('user_recovery_codes').insert(recoveryHashes.map((h) => ({ user_id: userId, code_hash: h })));
      }
      return true;
    });
  }

  async remove(userId: string): Promise<void> {
    await this.db.transaction(async (trx) => {
      await trx('user_recovery_codes').where({ user_id: userId }).del();
      await trx('user_mfa').where({ user_id: userId }).del();
    });
  }

  async replaceRecoveryCodes(userId: string, hashes: string[]): Promise<void> {
    await this.db.transaction(async (trx) => {
      await trx('user_recovery_codes').where({ user_id: userId }).del();
      if (hashes.length) await trx('user_recovery_codes').insert(hashes.map((h) => ({ user_id: userId, code_hash: h })));
    });
  }

  async countUnusedRecoveryCodes(userId: string): Promise<number> {
    const r = await this.db('user_recovery_codes').where({ user_id: userId }).whereNull('used_at').count<{ count: string }>('* as count').first();
    return Number(r?.count ?? 0);
  }

  async consumeRecoveryCode(userId: string, hash: string): Promise<boolean> {
    const n = await this.db('user_recovery_codes')
      .where({ user_id: userId, code_hash: hash })
      .whereNull('used_at')
      .update({ used_at: this.db.fn.now() });
    return n === 1;
  }

  async advanceStep(userId: string, step: number): Promise<boolean> {
    const n = await this.db('user_mfa')
      .where({ user_id: userId })
      .andWhere((q) => q.whereNull('last_step').orWhere('last_step', '<', step))
      .update({ last_step: step });
    return n === 1;
  }

  async registerFailure(userId: string, max: number, lockMs: number, now: Date): Promise<void> {
    await this.db.raw(
      `UPDATE user_mfa SET
         failed_attempts = CASE WHEN failed_attempts + 1 >= ? THEN 0 ELSE failed_attempts + 1 END,
         locked_until = CASE WHEN failed_attempts + 1 >= ? THEN ?::timestamptz ELSE locked_until END
       WHERE user_id = ?`,
      [max, max, new Date(now.getTime() + lockMs).toISOString(), userId],
    );
  }

  async resetFailures(userId: string): Promise<void> {
    await this.db('user_mfa').where({ user_id: userId }).update({ failed_attempts: 0, locked_until: null });
  }
}
