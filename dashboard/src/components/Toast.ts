/**
 * Toast notification system — lightweight snackbar feedback for user actions.
 *
 * Features:
 * - Slide-up animation from bottom-right
 * - Variant-specific left border colors (success=green, error=red, warning=yellow, info=blue)
 * - Auto-dismiss after configurable duration (default 4s)
 * - Close button (X)
 * - Stacks up to 5 toasts vertically (oldest at top)
 * - Optional action button (e.g., "Undo")
 * - CSS variable theming (dark mode compatible)
 * - Respects prefers-reduced-motion
 *
 * Usage:
 *   import { initToastContainer, showToast } from './Toast';
 *   initToastContainer(); // once at boot
 *   showToast({ message: 'Saved!', variant: 'success' });
 */

export type ToastVariant = 'success' | 'error' | 'warning' | 'info';

export interface ToastOptions {
  message: string;
  variant?: ToastVariant;
  duration?: number; // ms, default 4000
  action?: { label: string; onClick: () => void };
}

const CONTAINER_ID = 'pp-toast-container';
const MAX_TOASTS = 5;
const DEFAULT_DURATION = 4000;

/**
 * Initialize the toast container. Call once at application boot.
 * Creates a fixed-position container at the bottom-right of the viewport.
 */
export function initToastContainer(): void {
  if (document.getElementById(CONTAINER_ID)) return;
  const container = document.createElement('div');
  container.id = CONTAINER_ID;
  container.className = 'pp-toast-container';
  container.setAttribute('role', 'status');
  container.setAttribute('aria-live', 'polite');
  container.setAttribute('aria-relevant', 'additions');
  document.body.appendChild(container);
}

/**
 * Show a toast notification. The toast appears in the bottom-right,
 * auto-dismisses after the configured duration, and stacks with other
 * active toasts (max 5; oldest dismissed to make room).
 */
export function showToast(options: ToastOptions): void {
  const container = document.getElementById(CONTAINER_ID);
  if (!container) {
    // Container not initialized — silently ignore in case boot order is off.
    return;
  }

  const variant: ToastVariant = options.variant ?? 'info';
  const duration = options.duration ?? DEFAULT_DURATION;

  // Enforce max toasts — remove oldest (first child) to make room.
  while (container.children.length >= MAX_TOASTS) {
    const oldest = container.firstElementChild as HTMLElement | null;
    if (oldest) dismissToast(oldest);
  }

  // Build the toast element.
  const toast = document.createElement('div');
  toast.className = `pp-toast pp-toast--${variant}`;
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-atomic', 'true');

  // Message.
  const messageEl = document.createElement('span');
  messageEl.className = 'pp-toast__message';
  messageEl.textContent = options.message;
  toast.appendChild(messageEl);

  // Optional action button.
  if (options.action) {
    const actionBtn = document.createElement('button');
    actionBtn.className = 'pp-toast__action';
    actionBtn.textContent = options.action.label;
    actionBtn.type = 'button';
    const actionCallback = options.action.onClick;
    actionBtn.addEventListener('click', () => {
      actionCallback();
      dismissToast(toast);
    });
    toast.appendChild(actionBtn);
  }

  // Close button.
  const closeBtn = document.createElement('button');
  closeBtn.className = 'pp-toast__close';
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Dismiss notification');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => dismissToast(toast));
  toast.appendChild(closeBtn);

  // Append and animate in.
  container.appendChild(toast);

  // Force a reflow so the CSS transition from `translateY(100%)` kicks in.
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  toast.offsetHeight;
  toast.classList.add('pp-toast--visible');

  // Schedule auto-dismiss.
  if (duration > 0) {
    const timerId = window.setTimeout(() => dismissToast(toast), duration);
    (toast as ToastElement).__ppTimerId = timerId;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ToastElement extends HTMLElement {
  __ppTimerId?: number;
}

function dismissToast(toast: HTMLElement): void {
  // Prevent double-dismiss.
  if (!toast.parentElement) return;

  const timerId = (toast as ToastElement).__ppTimerId;
  if (timerId !== undefined) {
    window.clearTimeout(timerId);
    (toast as ToastElement).__ppTimerId = undefined;
  }

  toast.classList.remove('pp-toast--visible');
  toast.classList.add('pp-toast--dismissed');

  // Remove after the CSS exit animation completes.
  const onEnd = (): void => {
    toast.removeEventListener('transitionend', onEnd);
    toast.remove();
  };
  toast.addEventListener('transitionend', onEnd);

  // Fallback removal if transitionend never fires (e.g., reduced-motion
  // disables transitions).
  setTimeout(() => toast.remove(), 350);
}
