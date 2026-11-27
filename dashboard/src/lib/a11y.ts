/**
 * Accessibility utilities for the Pinpoint Dashboard (Mission B7).
 *
 * Provides helpers for:
 * - Linking form inputs to error messages via aria-describedby
 * - Focus trapping inside modals
 * - Keyboard navigation for menus/dropdowns
 */

let nextId = 0;

/**
 * Generate a unique ID for accessibility associations.
 */
export function uniqueId(prefix = 'pp'): string {
  return `${prefix}-${++nextId}`;
}

/**
 * Associate a form input with its error element via aria-describedby.
 * Sets role="alert" on the error element for live announcements.
 * Returns the generated error element ID for cleanup.
 */
export function linkInputToError(
  input: HTMLElement,
  errorEl: HTMLElement,
): string {
  const errorId = errorEl.id || uniqueId('error');
  errorEl.id = errorId;
  errorEl.setAttribute('role', 'alert');
  errorEl.setAttribute('aria-live', 'assertive');
  input.setAttribute('aria-describedby', errorId);
  return errorId;
}

/**
 * Trap focus inside a container (modal/dialog). Returns a cleanup function.
 * Handles Tab and Shift+Tab to cycle through focusable elements.
 */
export function trapFocus(container: HTMLElement): () => void {
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function getFocusable(): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter(el => el.offsetParent !== null); // visible only
  }

  function handleKeyDown(e: KeyboardEvent): void {
    if (e.key !== 'Tab') return;

    const focusable = getFocusable();
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  container.addEventListener('keydown', handleKeyDown);

  // Focus the first focusable element
  const focusable = getFocusable();
  if (focusable.length > 0) {
    queueMicrotask(() => focusable[0].focus());
  }

  return () => {
    container.removeEventListener('keydown', handleKeyDown);
  };
}
