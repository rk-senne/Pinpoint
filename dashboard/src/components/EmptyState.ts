/**
 * EmptyState — the one empty-state component used across the dashboard.
 *
 * `createEmptyState(type, options?)` builds a centred block with an inline SVG
 * illustration (aria-hidden, built with createElementNS — never innerHTML), a
 * title, a one-line explanation and — when the state has a sensible next step —
 * one primary button. Pass `options.onCta` to make the button do something;
 * otherwise it carries `data-action` for the host's `bindEvents`.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One SVG shape: [tagName, attributes]. */
export type IllustrationShape = readonly [
  'path' | 'circle' | 'rect' | 'line',
  Readonly<Record<string, string | number>>,
];

export interface EmptyStateConfig {
  /** Line-art illustration as a list of shapes (120x120 viewBox). */
  illustration: readonly IllustrationShape[];
  /** Heading text for the empty state. */
  title: string;
  /** One-line explanation below the title. */
  description: string;
  /** Optional primary call-to-action label. */
  ctaLabel?: string;
  /** Optional data-action value for the CTA button (used by bindEvents). */
  ctaAction?: string;
}

export type EmptyStateType =
  | 'no-projects'
  | 'no-annotations'
  | 'no-comments'
  | 'no-teams'
  | 'no-notifications'
  | 'no-search-results'
  | 'no-rules'
  | 'no-sla'
  | 'no-portals'
  | 'no-reports'
  | 'no-shared-annotations';

export interface EmptyStateOptions {
  /** Click handler for the primary button (rendered only if the state has one). */
  onCta?: () => void;
  /** Override the default CTA label. */
  ctaLabel?: string;
  /** Override the default title. */
  title?: string;
  /** Render no button even when the state defines one. */
  noCta?: boolean;
  /** Override the default description. */
  description?: string;
  /** Compact variant for tight containers (dropdowns, list cards). */
  compact?: boolean;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

// ---------------------------------------------------------------------------
// Illustrations (minimal line art)
// ---------------------------------------------------------------------------

const ART_NO_PROJECTS: IllustrationShape[] = [
  ['rect', { x: 20, y: 30, width: 80, height: 60, rx: 4 }],
  ['path', { d: 'M20 45h80' }],
  ['circle', { cx: 30, cy: 37.5, r: 2.5 }],
  ['circle', { cx: 40, cy: 37.5, r: 2.5 }],
  ['circle', { cx: 50, cy: 37.5, r: 2.5 }],
  ['path', { d: 'M45 65h30M50 75h20' }],
];

const ART_NO_ANNOTATIONS: IllustrationShape[] = [
  ['circle', { cx: 60, cy: 50, r: 30 }],
  ['path', { d: 'M60 35v15l10 10M45 95h30M50 100h20' }],
];

const ART_NO_COMMENTS: IllustrationShape[] = [
  ['path', { d: 'M25 30h70a5 5 0 0 1 5 5v40a5 5 0 0 1-5 5H55l-15 15v-15H25a5 5 0 0 1-5-5V35a5 5 0 0 1 5-5z' }],
  ['path', { d: 'M40 50h40M40 60h25' }],
];

const ART_NO_TEAMS: IllustrationShape[] = [
  ['circle', { cx: 60, cy: 40, r: 12 }],
  ['path', { d: 'M40 85a20 20 0 0 1 40 0' }],
  ['circle', { cx: 30, cy: 50, r: 8 }],
  ['path', { d: 'M18 80a14 14 0 0 1 24 0' }],
  ['circle', { cx: 90, cy: 50, r: 8 }],
  ['path', { d: 'M78 80a14 14 0 0 1 24 0' }],
];

const ART_NO_NOTIFICATIONS: IllustrationShape[] = [
  ['path', { d: 'M60 25c-15 0-25 12-25 25v20l-5 10h60l-5-10V50c0-13-10-25-25-25z' }],
  ['path', { d: 'M50 80a10 10 0 0 0 20 0M60 15v10' }],
];

const ART_NO_SEARCH: IllustrationShape[] = [
  ['circle', { cx: 52, cy: 52, r: 25 }],
  ['path', { d: 'M70 70l20 20M42 47h20M42 57h14' }],
];

/** A branching flow: trigger → action. */
const ART_NO_RULES: IllustrationShape[] = [
  ['rect', { x: 14, y: 22, width: 34, height: 22, rx: 4 }],
  ['rect', { x: 72, y: 22, width: 34, height: 22, rx: 4 }],
  ['rect', { x: 43, y: 76, width: 34, height: 22, rx: 4 }],
  ['path', { d: 'M48 33h24M31 44v12a6 6 0 0 0 6 6h17M89 44v12a6 6 0 0 1-6 6H66M60 62v14' }],
];

/** A clock with a target ring. */
const ART_NO_SLA: IllustrationShape[] = [
  ['circle', { cx: 60, cy: 60, r: 36 }],
  ['circle', { cx: 60, cy: 60, r: 3 }],
  ['path', { d: 'M60 36v24l16 10M60 20v6M60 94v6M20 60h6M94 60h6' }],
];

/** A browser window with a door/arrow into it. */
const ART_NO_PORTALS: IllustrationShape[] = [
  ['rect', { x: 18, y: 28, width: 84, height: 64, rx: 6 }],
  ['path', { d: 'M18 46h84' }],
  ['circle', { cx: 28, cy: 37, r: 2 }],
  ['circle', { cx: 37, cy: 37, r: 2 }],
  ['path', { d: 'M38 70h28M58 62l8 8-8 8' }],
  ['rect', { x: 74, y: 58, width: 16, height: 24, rx: 3 }],
];

const ART_NO_REPORTS: IllustrationShape[] = [
  ['path', { d: 'M22 98h78M30 98V70M52 98V52M74 98V62M96 98V36' }],
  ['path', { d: 'M26 56l24-20 22 12 26-24' }],
];

const ART_SHARED: IllustrationShape[] = [
  ['rect', { x: 26, y: 20, width: 68, height: 80, rx: 6 }],
  ['path', { d: 'M40 40h40M40 54h40M40 68h22' }],
  ['circle', { cx: 80, cy: 80, r: 10 }],
  ['path', { d: 'M87 87l8 8' }],
];

// ---------------------------------------------------------------------------
// Predefined configurations
// ---------------------------------------------------------------------------

const CONFIGS: Record<EmptyStateType, EmptyStateConfig> = {
  'no-projects': {
    illustration: ART_NO_PROJECTS,
    title: 'No projects yet',
    description: 'Create your first project to start collecting feedback on a page.',
    ctaLabel: '+ Create Project',
    ctaAction: 'createProject',
  },
  'no-annotations': {
    illustration: ART_NO_ANNOTATIONS,
    title: 'No annotations yet',
    description: 'Annotations will appear here once feedback is collected from your pages.',
  },
  'no-comments': {
    illustration: ART_NO_COMMENTS,
    title: 'No comments yet',
    description: 'Be the first to leave a comment on this annotation.',
  },
  'no-teams': {
    illustration: ART_NO_TEAMS,
    title: 'No teams yet',
    description: 'Create a team to collaborate with others on your projects.',
    ctaLabel: 'Create Team',
    ctaAction: 'createTeam',
  },
  'no-notifications': {
    illustration: ART_NO_NOTIFICATIONS,
    title: 'No notifications',
    description: "You're all caught up! New notifications will appear here.",
  },
  'no-search-results': {
    illustration: ART_NO_SEARCH,
    title: 'No results found',
    description: 'Try adjusting your search or filter criteria to find what you\u2019re looking for.',
  },
  'no-rules': {
    illustration: ART_NO_RULES,
    title: 'No automation rules',
    description: 'Rules assign, prioritise or notify automatically when feedback arrives.',
    ctaLabel: '+ Create Rule',
    ctaAction: 'create-rule',
  },
  'no-sla': {
    illustration: ART_NO_SLA,
    title: 'No SLA policies',
    description: 'Set response and resolution targets per severity to catch overdue feedback.',
    ctaLabel: '+ Create SLA',
    ctaAction: 'create-sla',
  },
  'no-portals': {
    illustration: ART_NO_PORTALS,
    title: 'No client portals',
    description: 'A portal gives clients a branded, read-only view of the feedback on one project.',
    ctaLabel: '+ Create Portal',
    ctaAction: 'showCreate',
  },
  'no-reports': {
    illustration: ART_NO_REPORTS,
    title: 'No report data yet',
    description: 'Charts appear here once your team has collected some feedback.',
    ctaLabel: 'Go to projects',
    ctaAction: 'goProjects',
  },
  'no-shared-annotations': {
    illustration: ART_SHARED,
    title: 'No annotations in this project',
    description: 'Feedback left on this project will show up here.',
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Build the aria-hidden illustration <svg> from shape specs (no innerHTML). */
export function buildIllustration(shapes: readonly IllustrationShape[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 120 120');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const [tag, attrs] of shapes) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    svg.appendChild(node);
  }
  return svg;
}

/**
 * Create an empty-state DOM element for the given predefined type.
 * Styled by `empty-state.css` (class `pp-empty-state`).
 */
export function createEmptyState(type: EmptyStateType, options: EmptyStateOptions = {}): HTMLElement {
  const base = CONFIGS[type];
  const config: EmptyStateConfig = {
    ...base,
    title: options.title ?? base.title,
    description: options.description ?? base.description,
    ctaLabel: options.noCta ? undefined : (options.ctaLabel ?? base.ctaLabel),
  };
  return createEmptyStateFromConfig(config, options);
}

/** Create an empty-state DOM element from a custom config object. */
export function createEmptyStateFromConfig(
  config: EmptyStateConfig,
  options: EmptyStateOptions = {},
): HTMLElement {
  const container = document.createElement('div');
  container.className = 'pp-empty-state';
  if (options.compact) container.classList.add('pp-empty-state--compact');
  container.setAttribute('role', 'status');

  const illustration = document.createElement('div');
  illustration.className = 'pp-empty-state__illustration';
  illustration.appendChild(buildIllustration(config.illustration));
  container.appendChild(illustration);

  const title = document.createElement('h3');
  title.className = 'pp-empty-state__title';
  title.textContent = config.title;
  container.appendChild(title);

  const description = document.createElement('p');
  description.className = 'pp-empty-state__description';
  description.textContent = config.description;
  container.appendChild(description);

  if (config.ctaLabel) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pp-empty-state__cta';
    button.textContent = config.ctaLabel;
    // An explicit handler wins over data-action so the host's bindEvents
    // never double-fires it.
    if (options.onCta) button.addEventListener('click', options.onCta);
    else if (config.ctaAction) button.setAttribute('data-action', config.ctaAction);
    container.appendChild(button);
  }

  return container;
}
