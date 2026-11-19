import { describe, expect, it } from 'vitest';

import {
  buildPortalBody,
  describeConditions,
  formatHours,
  normalizePortal,
  normalizeRule,
  normalizeSla,
  parseActionParams,
  slugify,
  validateSla,
} from './automationFormat';

describe('normalizeRule / normalizeSla', () => {
  it('maps snake_case rows and tolerates camelCase DTOs', () => {
    const rule = normalizeRule({
      id: 'r',
      name: 'N',
      trigger_event: 'comment.created',
      action_type: 'notify',
      action_params: { a: 1 },
      conditions: null,
      active: false,
      priority: '2',
      project_id: 'p',
    });
    expect(rule).toMatchObject({
      triggerEvent: 'comment.created',
      actionType: 'notify',
      actionParams: { a: 1 },
      conditions: {},
      active: false,
      priority: 2,
      projectId: 'p',
    });
    expect(normalizeRule({ id: 'x', triggerEvent: 't', actionType: 'a' })).toMatchObject({ triggerEvent: 't', active: true, projectId: null });
    expect(normalizeSla({ id: 's', name: 'S', severity: 'minor', response_time_hours: 2, resolution_time_hours: '9' })).toEqual({
      id: 's',
      name: 'S',
      severity: 'minor',
      responseTimeHours: 2,
      resolutionTimeHours: 9,
    });
  });
});

describe('describeConditions / formatHours', () => {
  it('summarises conditions and humanises durations', () => {
    expect(describeConditions({})).toBe('');
    expect(describeConditions({ severity: 'critical', tags: ['a'] })).toBe('severity = critical, tags = ["a"]');
    expect(formatHours(1)).toBe('1 hour');
    expect(formatHours(8)).toBe('8 hours');
    expect(formatHours(48)).toBe('2 days');
    expect(formatHours(50)).toBe('50 hours');
  });
});

describe('parseActionParams', () => {
  it('accepts blank, objects; rejects bad JSON, arrays and scalars', () => {
    expect(parseActionParams('  ')).toEqual({ ok: true, value: {} });
    expect(parseActionParams('{"status":"resolved"}')).toEqual({ ok: true, value: { status: 'resolved' } });
    expect(parseActionParams('{nope')).toMatchObject({ ok: false });
    expect(parseActionParams('[1]')).toMatchObject({ ok: false });
    expect(parseActionParams('"x"')).toMatchObject({ ok: false });
    expect(parseActionParams('null')).toMatchObject({ ok: false });
  });
});

describe('validateSla', () => {
  it('requires a name and whole-hour targets with resolution >= response', () => {
    expect(validateSla({ name: ' ', responseTimeHours: 1, resolutionTimeHours: 2 })).toMatch(/name/);
    expect(validateSla({ name: 'a', responseTimeHours: 0, resolutionTimeHours: 2 })).toMatch(/Response/);
    expect(validateSla({ name: 'a', responseTimeHours: 1.5, resolutionTimeHours: 2 })).toMatch(/Response/);
    expect(validateSla({ name: 'a', responseTimeHours: 1, resolutionTimeHours: NaN })).toMatch(/Resolution/);
    expect(validateSla({ name: 'a', responseTimeHours: 5, resolutionTimeHours: 2 })).toMatch(/shorter/);
    expect(validateSla({ name: 'a', responseTimeHours: 2, resolutionTimeHours: 2 })).toBeNull();
  });
});

describe('normalizePortal', () => {
  it('reads snake_case, validates the brand colour and defaults active', () => {
    expect(normalizePortal({ id: 'p', project_id: 'pr', title: 'T', slug: 's', brand_color: '#ABCDEF', logo_url: null })).toMatchObject({
      projectId: 'pr',
      brandColor: '#ABCDEF',
      active: true,
    });
    expect(normalizePortal({ id: 'p', brandColor: 'red' }).brandColor).toBe('#4f46e5');
    expect(normalizePortal({ id: 'p', brand_color: '#fff' }).brandColor).toBe('#4f46e5');
  });
});

describe('slugify', () => {
  it('produces [a-z0-9-] slugs', () => {
    expect(slugify('Northwind: Client Review!')).toBe('northwind-client-review');
    expect(slugify('  Café   Déjà vu ')).toBe('cafe-deja-vu');
    expect(slugify('***')).toBe('');
    expect(slugify('a'.repeat(150))).toHaveLength(100);
  });
});

describe('buildPortalBody', () => {
  const base = { projectId: 'p', title: 'T', slug: 'my-slug', welcomeMessage: '', brandColor: '#112233', logoUrl: '' };

  it('omits blank optional fields', () => {
    expect(buildPortalBody(base)).toEqual({ ok: true, body: { title: 'T', slug: 'my-slug', projectId: 'p', brandColor: '#112233' } });
  });

  it('includes trimmed welcome message and a valid logo URL', () => {
    const r = buildPortalBody({ ...base, welcomeMessage: ' Hi ', logoUrl: ' https://x.test/l.png ' });
    expect(r).toMatchObject({ ok: true, body: { welcomeMessage: 'Hi', logoUrl: 'https://x.test/l.png' } });
  });

  it('reports each invalid field', () => {
    const r = buildPortalBody({ ...base, projectId: '', title: ' ', slug: 'Bad Slug', logoUrl: 'javascript:alert(1)' });
    expect(r).toEqual({
      ok: false,
      errors: {
        projectId: 'Choose a project.',
        title: 'Give the portal a title.',
        slug: 'Use lowercase letters, numbers and hyphens only.',
        logoUrl: 'Enter a full URL, e.g. https://example.com/logo.png.',
      },
    });
    expect(buildPortalBody({ ...base, slug: 'ab' })).toMatchObject({ ok: false, errors: { slug: expect.stringContaining('3') } });
    expect(buildPortalBody({ ...base, slug: '' })).toMatchObject({ ok: false, errors: { slug: 'Choose a URL slug.' } });
  });

  it('skips the project requirement when editing', () => {
    expect(buildPortalBody({ ...base, projectId: '' }, { requireProject: false })).toMatchObject({ ok: true });
  });
});
