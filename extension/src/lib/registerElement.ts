/**
 * Custom Element registration helper — registers components under both
 * the new `pp-*` prefix and the legacy `fl-*` prefix for backwards
 * compatibility with existing installations.
 *
 * Mission E4: Rename fl-* Custom Elements to pp-*
 *
 * Strategy:
 * - New canonical tag name uses `pp-` prefix (Pinpoint branding)
 * - Legacy `fl-` tag is registered as an alias (same class, no warning)
 * - Both names resolve to the exact same class instance
 * - Internal code uses `pp-` going forward; external users get a grace period
 *
 * Usage:
 *   registerElement('overlay-host', OverlayHost);
 *   // Registers both <pp-overlay-host> and <fl-overlay-host>
 */

/**
 * Register a Custom Element under both `pp-{name}` and `fl-{name}`.
 * Safe to call multiple times (skips if already defined).
 */
export function registerElement(name: string, constructor: CustomElementConstructor): void {
  const ppTag = `pp-${name}`;
  const flTag = `fl-${name}`;

  if (!customElements.get(ppTag)) {
    customElements.define(ppTag, constructor);
  }

  // Register the legacy fl- alias using the same class via a thin subclass.
  // customElements.define requires a unique constructor per tag, so we create
  // a minimal subclass that delegates everything to the parent.
  if (!customElements.get(flTag)) {
    // Create a subclass dynamically so the registry accepts a "new" constructor
    const LegacyAlias = class extends constructor {};
    customElements.define(flTag, LegacyAlias);
  }
}

/**
 * Tag name map — maps the base name (without prefix) to both the canonical
 * and legacy tag names. Use this when building querySelector strings.
 */
export function ppTag(name: string): string {
  return `pp-${name}`;
}

export function flTag(name: string): string {
  return `fl-${name}`;
}
