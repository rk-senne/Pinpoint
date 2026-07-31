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

/**
 * Add keyboard navigation to a menu/dropdown. Supports ArrowUp, ArrowDown,
 * Home, End, and Enter/Space for activation. Returns a cleanup function.
 */
export function keyboardMenu(container: HTMLElement, itemSelector = '[role="menuitem"]'): () => void {
  function getItems(): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>(itemSelector));
  }

  function handleKeyDown(e: KeyboardEvent): void {
    const items = getItems();
    if (items.length === 0) return;

    const currentIndex = items.indexOf(document.activeElement as HTMLElement);

    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault();
        const next = currentIndex < items.length - 1 ? currentIndex + 1 : 0;
        items[next].focus();
        break;
      }
      case 'ArrowUp': {
        e.preventDefault();
        const prev = currentIndex > 0 ? currentIndex - 1 : items.length - 1;
        items[prev].focus();
        break;
      }
      case 'Home': {
        e.preventDefault();
        items[0].focus();
        break;
      }
      case 'End': {
        e.preventDefault();
        items[items.length - 1].focus();
        break;
      }
      case 'Escape': {
        container.dispatchEvent(new CustomEvent('menu-close', { bubbles: true }));
        break;
      }
    }
  }

  container.addEventListener('keydown', handleKeyDown);
  container.setAttribute('role', 'menu');

  // Set role=menuitem on each item
  for (const item of getItems()) {
    if (!item.getAttribute('role')) {
      item.setAttribute('role', 'menuitem');
    }
    item.setAttribute('tabindex', '-1');
  }

  // First item gets tabindex=0
  const items = getItems();
  if (items.length > 0) {
    items[0].setAttribute('tabindex', '0');
  }

  return () => {
    container.removeEventListener('keydown', handleKeyDown);
  };
}
