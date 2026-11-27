/**
 * Pure helpers for the Workflows and Client Portals pages: wire-format
 * normalisation (the routes return raw snake_case DB rows), label formatting
 * and form-input parsing. Kept DOM-free so it is unit-testable.
 */

// ---------------------------------------------------------------------------
// Workflow rules / SLA policies
// ---------------------------------------------------------------------------

export interface AutomationRule {
  id: string;
  name: string;
  triggerEvent: string;
  actionType: string;
  actionParams: Record<string, unknown>;
  conditions: Record<string, unknown>;
  active: boolean;
  priority: number;
  projectId: string | null;
}

export interface SlaPolicy {
  id: string;
  name: string;
  severity: string;
  responseTimeHours: number;
  resolutionTimeHours: number;
}

type Raw = Record<string, unknown>;

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Accept both the snake_case DB row and a camelCase DTO. */
export function normalizeRule(raw: Raw): AutomationRule {
  return {
    id: String(raw.id),
    name: String(raw.name ?? ''),
    triggerEvent: String(raw.triggerEvent ?? raw.trigger_event ?? ''),
    actionType: String(raw.actionType ?? raw.action_type ?? ''),
    actionParams: asRecord(raw.actionParams ?? raw.action_params),
    conditions: asRecord(raw.conditions),
    active: raw.active !== false,
    priority: Number(raw.priority ?? 0),
    projectId: (raw.projectId ?? raw.project_id ?? null) as string | null,
  };
}

export function normalizeSla(raw: Raw): SlaPolicy {
  return {
    id: String(raw.id),
    name: String(raw.name ?? ''),
    severity: String(raw.severity ?? ''),
    responseTimeHours: Number(raw.responseTimeHours ?? raw.response_time_hours ?? 0),
    resolutionTimeHours: Number(raw.resolutionTimeHours ?? raw.resolution_time_hours ?? 0),
  };
}

export interface SlaBreach {
  id: string;
  annotationId: string;
  breachType: 'response' | 'resolution' | string;
  severity: string;
  status: string;
  /** Annotation text, truncated for display. */
  excerpt: string;
  breachedAt: string;
}

const BREACH_EXCERPT_MAX = 140;

/** `GET /workflows/sla/breaches` rows → display shape (snake_case + joined annotation columns). */
export function normalizeBreach(raw: Raw): SlaBreach {
  const body = String(raw.body ?? '').replace(/\s+/g, ' ').trim();
  return {
    id: String(raw.id),
    annotationId: String(raw.annotation_id ?? raw.annotationId ?? ''),
    breachType: String(raw.breach_type ?? raw.breachType ?? ''),
    severity: String(raw.severity ?? ''),
    status: String(raw.status ?? ''),
    excerpt: body.length > BREACH_EXCERPT_MAX ? `${body.slice(0, BREACH_EXCERPT_MAX - 1)}…` : body,
    breachedAt: String(raw.breached_at ?? raw.breachedAt ?? ''),
  };
}

export function breachTypeLabel(type: string): string {
  return type === 'response' ? 'Response SLA missed' : type === 'resolution' ? 'Resolution SLA missed' : 'SLA missed';
}

export const TRIGGER_LABELS: Record<string, string> = {
  'annotation.created': 'Annotation created',
  'annotation.status_changed': 'Status changed',
  'comment.created': 'Comment created',
};

export const ACTION_LABELS: Record<string, string> = {
  assign: 'Assign',
  set_status: 'Set status',
  set_due_date: 'Set due date',
  notify: 'Notify',
};

/** Starter JSON per action so the params box is never a blank guess. */
export const ACTION_PARAM_HINTS: Record<string, string> = {
  assign: '{"assigneeId": "<user id>"}',
  set_status: '{"status": "in_progress"}',
  set_due_date: '{"daysFromNow": 3}',
  notify: '{"channel": "email", "recipients": "team"}',
};

export function triggerLabel(v: string): string {
  return TRIGGER_LABELS[v] ?? v;
}

export function actionLabel(v: string): string {
  return ACTION_LABELS[v] ?? v;
}

/** `severity = critical` style summary of a rule's conditions ('' when none). */
export function describeConditions(conditions: Record<string, unknown>): string {
  return Object.entries(conditions)
    .map(([k, v]) => `${k} = ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(', ');
}

export type ParamsResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

/** Parse the "action params" textarea: blank → `{}`, otherwise a JSON object. */
export function parseActionParams(raw: string): ParamsResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: 'Action params must be valid JSON.' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Action params must be a JSON object, e.g. {"status": "resolved"}.' };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

export interface SlaInput {
  name: string;
  responseTimeHours: number;
  resolutionTimeHours: number;
}

/** Validate the SLA form; returns an error message or null. */
export function validateSla(input: SlaInput): string | null {
  if (!input.name.trim()) return 'Give the policy a name.';
  const whole = (n: number): boolean => Number.isInteger(n) && n >= 1;
  if (!whole(input.responseTimeHours)) return 'Response time must be a whole number of hours (1 or more).';
  if (!whole(input.resolutionTimeHours)) return 'Resolution time must be a whole number of hours (1 or more).';
  if (input.resolutionTimeHours < input.responseTimeHours) {
    return 'Resolution time cannot be shorter than response time.';
  }
  return null;
}

export function formatHours(h: number): string {
  if (h >= 48 && h % 24 === 0) return `${h / 24} days`;
  return h === 1 ? '1 hour' : `${h} hours`;
}

// ---------------------------------------------------------------------------
// Client portals
// ---------------------------------------------------------------------------

export interface Portal {
  id: string;
  projectId: string;
  title: string;
  slug: string;
  brandColor: string;
  logoUrl: string | null;
  welcomeMessage: string | null;
  active: boolean;
}

export const DEFAULT_BRAND_COLOR = '#4f46e5';

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function normalizePortal(raw: Raw): Portal {
  const color = String(raw.brandColor ?? raw.brand_color ?? '');
  return {
    id: String(raw.id),
    projectId: String(raw.projectId ?? raw.project_id ?? ''),
    title: String(raw.title ?? ''),
    slug: String(raw.slug ?? ''),
    brandColor: HEX_COLOR.test(color) ? color : DEFAULT_BRAND_COLOR,
    logoUrl: (raw.logoUrl ?? raw.logo_url ?? null) as string | null,
    welcomeMessage: (raw.welcomeMessage ?? raw.welcome_message ?? null) as string | null,
    active: raw.active !== false,
  };
}

/** Lower-case, hyphen-separated slug (`[a-z0-9-]`, max 100 chars). */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
    .replace(/-+$/g, '');
}

export interface PortalFormInput {
  projectId: string;
  title: string;
  slug: string;
  welcomeMessage: string;
  brandColor: string;
  logoUrl: string;
}

export type PortalFormResult =
  | { ok: true; body: Record<string, string> }
  | { ok: false; errors: Partial<Record<keyof PortalFormInput, string>> };

/**
 * Validate the portal form against the server's schema (slug `[a-z0-9-]{3,100}`,
 * valid URL when given) and build the request body, OMITTING blank optional
 * fields — the API rejects `logoUrl: ""` as an invalid URL.
 */
export function buildPortalBody(input: PortalFormInput, opts: { requireProject?: boolean } = {}): PortalFormResult {
  const errors: Partial<Record<keyof PortalFormInput, string>> = {};
  const requireProject = opts.requireProject ?? true;
  if (requireProject && !input.projectId) errors.projectId = 'Choose a project.';
  if (!input.title.trim()) errors.title = 'Give the portal a title.';
  const slug = input.slug.trim();
  if (!slug) errors.slug = 'Choose a URL slug.';
  else if (!/^[a-z0-9-]+$/.test(slug)) errors.slug = 'Use lowercase letters, numbers and hyphens only.';
  else if (slug.length < 3) errors.slug = 'Slug must be at least 3 characters.';
  const logo = input.logoUrl.trim();
  if (logo) {
    try {
      const u = new URL(logo);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('scheme');
    } catch {
      errors.logoUrl = 'Enter a full URL, e.g. https://example.com/logo.png.';
    }
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const body: Record<string, string> = { title: input.title.trim(), slug };
  if (requireProject) body.projectId = input.projectId;
  if (input.welcomeMessage.trim()) body.welcomeMessage = input.welcomeMessage.trim();
  if (HEX_COLOR.test(input.brandColor)) body.brandColor = input.brandColor;
  if (logo) body.logoUrl = logo;
  return { ok: true, body };
}
