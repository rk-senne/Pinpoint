/**
 * EmptyState — reusable empty-state component (Mission B8).
 *
 * Provides a `createEmptyState(type)` function that builds a centered
 * empty-state element with an inline SVG illustration, title, description,
 * and optional CTA button. The component is used across the dashboard
 * wherever a list or section has no content to display.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmptyStateConfig {
  /** Inline SVG markup (simple line art illustration). */
  svg: string;
  /** Heading text for the empty state. */
  title: string;
  /** Descriptive paragraph below the title. */
  description: string;
  /** Optional call-to-action button label. */
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
  | 'no-search-results';

// ---------------------------------------------------------------------------
// SVG illustrations (minimal line art using path elements)
// ---------------------------------------------------------------------------

const SVG_NO_PROJECTS = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <rect x="20" y="30" width="80" height="60" rx="4"/>
  <path d="M20 45h80"/>
  <circle cx="30" cy="37.5" r="2.5"/>
  <circle cx="40" cy="37.5" r="2.5"/>
  <circle cx="50" cy="37.5" r="2.5"/>
  <path d="M45 65h30"/>
  <path d="M50 75h20"/>
  <path d="M60 55v-2 m0 8v2"/>
</svg>`;

const SVG_NO_ANNOTATIONS = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <circle cx="60" cy="50" r="30"/>
  <path d="M60 35v15l10 10"/>
  <path d="M45 95h30"/>
  <path d="M50 100h20"/>
</svg>`;

const SVG_NO_COMMENTS = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M25 30h70a5 5 0 0 1 5 5v40a5 5 0 0 1-5 5H55l-15 15v-15H25a5 5 0 0 1-5-5V35a5 5 0 0 1 5-5z"/>
  <path d="M40 50h40"/>
  <path d="M40 60h25"/>
</svg>`;

const SVG_NO_TEAMS = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <circle cx="60" cy="40" r="12"/>
  <path d="M40 85a20 20 0 0 1 40 0"/>
  <circle cx="30" cy="50" r="8"/>
  <path d="M18 80a14 14 0 0 1 24 0"/>
  <circle cx="90" cy="50" r="8"/>
  <path d="M78 80a14 14 0 0 1 24 0"/>
</svg>`;

const SVG_NO_NOTIFICATIONS = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M60 25c-15 0-25 12-25 25v20l-5 10h60l-5-10V50c0-13-10-25-25-25z"/>
  <path d="M50 80a10 10 0 0 0 20 0"/>
  <path d="M60 15v10"/>
</svg>`;

const SVG_NO_SEARCH_RESULTS = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <circle cx="52" cy="52" r="25"/>
  <path d="M70 70l20 20"/>
  <path d="M42 47h20"/>
  <path d="M42 57h14"/>
</svg>`;

// ---------------------------------------------------------------------------
// Predefined configurations
// ---------------------------------------------------------------------------

const CONFIGS: Record<EmptyStateType, EmptyStateConfig> = {
  'no-projects': {
    svg: SVG_NO_PROJECTS,
    title: 'No projects yet',
    description:
      'Create your first project to start collecting feedback on a page.',
    ctaLabel: '+ Create Project',
    ctaAction: 'createProject',
  },
  'no-annotations': {
    svg: SVG_NO_ANNOTATIONS,
    title: 'No annotations yet',
    description:
      'Annotations will appear here once feedback is collected from your pages.',
  },
  'no-comments': {
    svg: SVG_NO_COMMENTS,
    title: 'No comments yet',
    description: 'Be the first to leave a comment on this annotation.',
  },
  'no-teams': {
    svg: SVG_NO_TEAMS,
    title: 'No teams yet',
    description:
      'Create a team to collaborate with others on your projects.',
    ctaLabel: 'Create Team',
    ctaAction: 'createTeam',
  },
  'no-notifications': {
    svg: SVG_NO_NOTIFICATIONS,
    title: 'No notifications',
    description: "You're all caught up! New notifications will appear here.",
  },
  'no-search-results': {
    svg: SVG_NO_SEARCH_RESULTS,
    title: 'No results found',
    description:
      'Try adjusting your search or filter criteria to find what you're looking for.',
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create an empty-state DOM element for the given predefined type.
 *
 * The returned element uses the class `pp-empty-state` for styling via
 * `empty-state.css`.
 */
export function createEmptyState(type: EmptyStateType): HTMLElement {
  const config = CONFIGS[type];
  return createEmptyStateFromConfig(config);
}

/**
 * Create an empty-state DOM element from a custom config object.
 */
export function createEmptyStateFromConfig(config: EmptyStateConfig): HTMLElement {
  const container = document.createElement('div');
  container.className = 'pp-empty-state';
  container.setAttribute('role', 'status');

  // SVG illustration
  const svgWrapper = document.createElement('div');
  svgWrapper.className = 'pp-empty-state__illustration';
  svgWrapper.innerHTML = config.svg;
  container.appendChild(svgWrapper);

  // Title
  const title = document.createElement('h3');
  title.className = 'pp-empty-state__title';
  title.textContent = config.title;
  container.appendChild(title);

  // Description
  const description = document.createElement('p');
  description.className = 'pp-empty-state__description';
  description.textContent = config.description;
  container.appendChild(description);

  // Optional CTA button
  if (config.ctaLabel) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pp-empty-state__cta';
    button.textContent = config.ctaLabel;
    if (config.ctaAction) {
      button.setAttribute('data-action', config.ctaAction);
    }
    container.appendChild(button);
  }

  return container;
}
