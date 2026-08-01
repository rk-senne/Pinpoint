/**
 * Skeleton — reusable skeleton loading state components (Mission B2).
 *
 * Provides shimmer-animated placeholder shapes to replace plain "Loading…"
 * text in the dashboard. Three prebuilt variants cover the common dashboard
 * surfaces: card grids, annotation lists, and form fields.
 *
 * CSS lives in `styles/skeleton.css` and must be imported in `main.ts`.
 */

export interface SkeletonConfig {
  /** Number of text lines (default 3). */
  lines?: number;
  /** Custom height for block skeletons. */
  height?: string;
  /** Custom width. */
  width?: string;
  /** Shape variant. */
  variant?: 'text' | 'card' | 'circle';
}

/**
 * Creates a generic skeleton placeholder element with animated shimmer.
 * Supports text lines, card blocks, and circle avatars.
 */
export function createSkeleton(config?: SkeletonConfig): HTMLElement {
  const { lines = 3, height, width, variant = 'text' } = config ?? {};

  const container = document.createElement('div');
  container.classList.add('pp-skeleton-container');
  container.setAttribute('aria-busy', 'true');
  container.setAttribute('aria-label', 'Loading content');
  container.setAttribute('role', 'status');

  if (variant === 'circle') {
    const circle = document.createElement('div');
    circle.classList.add('pp-skeleton', 'pp-skeleton--circle');
    if (height) circle.style.width = height;
    if (height) circle.style.height = height;
    container.appendChild(circle);
    return container;
  }

  if (variant === 'card') {
    const card = document.createElement('div');
    card.classList.add('pp-skeleton', 'pp-skeleton--card');
    if (height) card.style.height = height;
    if (width) card.style.width = width;
    container.appendChild(card);
    return container;
  }

  // Text variant — render multiple lines with varying widths.
  for (let i = 0; i < lines; i++) {
    const line = document.createElement('div');
    line.classList.add('pp-skeleton', 'pp-skeleton--text');
    // Last line is shorter to look natural.
    if (i === lines - 1) {
      line.style.width = width ?? '60%';
    } else {
      line.style.width = width ?? '100%';
    }
    if (height) line.style.height = height;
    container.appendChild(line);
  }

  return container;
}

/**
 * Card-shaped skeleton — mimics a project card in the dashboard home grid.
 * Returns a single card element with a header line and two body lines.
 */
export function createCardSkeleton(): HTMLElement {
  const card = document.createElement('div');
  card.classList.add('pp-skeleton-card');
  card.setAttribute('aria-hidden', 'true');

  // Title line
  const title = document.createElement('div');
  title.classList.add('pp-skeleton', 'pp-skeleton--text');
  title.style.width = '70%';
  title.style.height = '16px';
  title.style.marginBottom = '12px';

  // Status badge line
  const badge = document.createElement('div');
  badge.classList.add('pp-skeleton', 'pp-skeleton--text');
  badge.style.width = '40%';
  badge.style.height = '12px';
  badge.style.marginBottom = '8px';

  // Activity line
  const activity = document.createElement('div');
  activity.classList.add('pp-skeleton', 'pp-skeleton--text');
  activity.style.width = '55%';
  activity.style.height = '12px';

  card.appendChild(title);
  card.appendChild(badge);
  card.appendChild(activity);

  return card;
}

/**
 * List rows skeleton — mimics annotation list rows for the project view.
 * Returns a container with the specified number of skeleton rows (default 5).
 */
export function createListSkeleton(rows?: number): HTMLElement {
  const count = rows ?? 5;
  const container = document.createElement('div');
  container.classList.add('pp-skeleton-list');
  container.setAttribute('aria-busy', 'true');
  container.setAttribute('aria-label', 'Loading list');
  container.setAttribute('role', 'status');

  for (let i = 0; i < count; i++) {
    const row = document.createElement('div');
    row.classList.add('pp-skeleton-list__row');

    // Pin number placeholder
    const pin = document.createElement('div');
    pin.classList.add('pp-skeleton', 'pp-skeleton--text');
    pin.style.width = '24px';
    pin.style.height = '14px';

    // Body text placeholder
    const body = document.createElement('div');
    body.classList.add('pp-skeleton', 'pp-skeleton--text');
    body.style.width = `${65 + (i % 3) * 10}%`;
    body.style.height = '14px';

    // Status placeholder
    const status = document.createElement('div');
    status.classList.add('pp-skeleton', 'pp-skeleton--text');
    status.style.width = '60px';
    status.style.height = '14px';

    row.appendChild(pin);
    row.appendChild(body);
    row.appendChild(status);
    container.appendChild(row);
  }

  return container;
}

/**
 * Form field skeletons — mimics form inputs for the settings page.
 * Returns a container with label + input shaped skeletons.
 */
export function createFormSkeleton(fields?: number): HTMLElement {
  const count = fields ?? 3;
  const container = document.createElement('div');
  container.classList.add('pp-skeleton-form');
  container.setAttribute('aria-busy', 'true');
  container.setAttribute('aria-label', 'Loading form');
  container.setAttribute('role', 'status');

  for (let i = 0; i < count; i++) {
    const field = document.createElement('div');
    field.classList.add('pp-skeleton-form__field');

    // Label
    const label = document.createElement('div');
    label.classList.add('pp-skeleton', 'pp-skeleton--text');
    label.style.width = '80px';
    label.style.height = '12px';
    label.style.marginBottom = '6px';

    // Input
    const input = document.createElement('div');
    input.classList.add('pp-skeleton', 'pp-skeleton--text');
    input.style.width = '100%';
    input.style.height = '32px';

    field.appendChild(label);
    field.appendChild(input);
    container.appendChild(field);
  }

  return container;
}
