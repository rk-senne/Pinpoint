// Integration (real Postgres): automation rules are EXECUTED — they used to be
// stored but never run. Skips gracefully when the test DB is unreachable.

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import knex, { type Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyRules, conditionsMatch } from '../../services/workflowEngine.js';

const SERVER_ROOT = path.resolve(__dirname, '..', '..', '..');
const noopLogger = { info() {}, warn() {}, error() {}, debug() {} } as never;
let db: Knex | null = null;

const org = randomUUID();
const user = randomUUID();
const outsider = randomUUID();
const projectId = randomUUID();
const pageId = randomUUID();
const TARGET = { cssSelector: 'div', xpath: '/div', pageX: 1, pageY: 2, tagName: 'DIV', textSnippet: '' };
const ENV = { browserFamily: 'Chrome', browserVersion: '1', osFamily: 'macOS', osVersion: '1', deviceType: 'desktop', userAgentRaw: 'ua' };

describe('conditionsMatch', () => {
  it('requires every present condition to equal the annotation field', () => {
    expect(conditionsMatch({}, { severity: 'minor' })).toBe(true);
    expect(conditionsMatch({ severity: 'critical' }, { severity: 'critical', type: 'note' })).toBe(true);
    expect(conditionsMatch({ severity: 'critical' }, { severity: 'minor' })).toBe(false);
    expect(conditionsMatch('{"type":"note","severity":"minor"}', { severity: 'minor', type: 'note' })).toBe(true);
  });
});

describe('Integration: applyRules (real SQL)', () => {
  beforeAll(async () => {
    if (process.env.SKIP_INTEGRATION_TESTS === 'true') return;
    try {
      db = knex({
        client: 'pg',
        connection: {
          host: process.env.DB_HOST || 'localhost',
          port: Number(process.env.DB_PORT) || 5432,
          database: process.env.DB_NAME || 'pinpoint_test',
          user: process.env.DB_USER || 'postgres',
          password: process.env.DB_PASSWORD || 'postgres',
        },
        pool: { min: 1, max: 4 },
        migrations: { directory: path.join(SERVER_ROOT, 'src', 'migrations'), extension: 'ts' },
      });
      await db.raw('SELECT 1');
      await db.migrate.latest();
    } catch {
      if (db) await db.destroy().catch(() => {});
      db = null;
      return;
    }
    await db('organizations').insert({ id: org, name: `wf-${org}`, slug: `wf-${org}` });
    await db('users').insert([
      { id: user, email: `u-${user}@wf.test`, name: 'u', password_hash: 'x', verified: true },
      { id: outsider, email: `o-${outsider}@wf.test`, name: 'o', password_hash: 'x', verified: true },
    ]);
    await db('memberships').insert({ org_id: org, user_id: user, role: 'owner' });
    await db('projects').insert({ id: projectId, name: 'P', urls: ['https://wf.test/'], status: 'active', owner_id: user, org_id: org, pin_counter: 0 });
    await db('pages').insert({ id: pageId, project_id: projectId, url: 'https://wf.test/' });
  });

  afterAll(async () => {
    if (!db) return;
    await db('annotations').where({ project_id: projectId }).del();
    await db('automation_rules').where({ org_id: org }).del();
    await db('pages').where({ id: pageId }).del();
    await db('projects').where({ id: projectId }).del();
    await db('memberships').where({ org_id: org }).del();
    await db('users').whereIn('id', [user, outsider]).del();
    await db('organizations').where({ id: org }).del();
    await db.destroy();
  });

  async function annotation(severity: string): Promise<{ id: string; projectId: string; severity: string; type: string; status: string }> {
    const [row] = await db!('annotations')
      .insert({
        project_id: projectId, page_id: pageId, org_id: org, author_id: user, type: 'note', severity,
        status: 'active', body: 'seed', target: JSON.stringify(TARGET), environment: JSON.stringify(ENV),
        pin_number: Math.floor(Math.random() * 1e6),
      })
      .returning('id');
    return { id: (row as { id: string }).id, projectId, severity, type: 'note', status: 'active' };
  }
  const rule = (name: string, actionType: string, actionParams: unknown, conditions: unknown = {}) =>
    db!('automation_rules').insert({
      org_id: org, name, trigger_event: 'annotation.created', action_type: actionType,
      action_params: JSON.stringify(actionParams), conditions: JSON.stringify(conditions),
    });
  const reload = (id: string) => db!('annotations').where({ id }).first();

  it('applies assign / set_status / set_due_date only to matching annotations', async (ctx) => {
    if (!db) return ctx.skip();
    await rule('assign critical', 'assign', { assigneeId: user }, { severity: 'critical' });
    await rule('triage critical', 'set_status', { status: 'in_progress' }, { severity: 'critical' });
    await rule('due', 'set_due_date', { daysFromNow: 3 }, { severity: 'critical' });

    const crit = await annotation('critical');
    expect(await applyRules(db, noopLogger, 'annotation.created', crit)).toBe(3);
    const after = await reload(crit.id);
    expect(after.assignee_id).toBe(user);
    expect(after.status).toBe('in_progress');
    expect(after.due_date).toBeTruthy();

    const minor = await annotation('minor');
    expect(await applyRules(db, noopLogger, 'annotation.created', minor)).toBe(0);
    const untouched = await reload(minor.id);
    expect(untouched.assignee_id).toBeNull();
    expect(untouched.status).toBe('active');
  });

  it('never assigns a user outside the org and ignores inactive rules / other triggers', async (ctx) => {
    if (!db) return ctx.skip();
    await db('automation_rules').where({ org_id: org }).del();
    await rule('outsider', 'assign', { assigneeId: outsider });
    await db('automation_rules').insert({
      org_id: org, name: 'off', active: false, trigger_event: 'annotation.created', action_type: 'set_status',
      action_params: JSON.stringify({ status: 'resolved' }), conditions: '{}',
    });
    const a = await annotation('major');
    expect(await applyRules(db, noopLogger, 'annotation.created', a)).toBe(0);
    expect(await applyRules(db, noopLogger, 'annotation.status_changed', a)).toBe(0);
    const after = await reload(a.id);
    expect(after.assignee_id).toBeNull();
    expect(after.status).toBe('active');
  });
});
