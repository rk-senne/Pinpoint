/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initToastContainer, showToast } from './Toast';

describe('Toast', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('initToastContainer', () => {
    it('creates a fixed container in the document body', () => {
      initToastContainer();
      const container = document.getElementById('pp-toast-container');
      expect(container).not.toBeNull();
      expect(container!.className).toBe('pp-toast-container');
      expect(container!.getAttribute('aria-live')).toBe('polite');
    });

    it('does not create duplicate containers on repeated calls', () => {
      initToastContainer();
      initToastContainer();
      const containers = document.querySelectorAll('#pp-toast-container');
      expect(containers.length).toBe(1);
    });
  });

  describe('showToast', () => {
    beforeEach(() => {
      initToastContainer();
    });

    it('creates a toast element in the container', () => {
      showToast({ message: 'Hello' });
      const container = document.getElementById('pp-toast-container')!;
      expect(container.children.length).toBe(1);
      const toast = container.firstElementChild as HTMLElement;
      expect(toast.classList.contains('pp-toast')).toBe(true);
      expect(toast.classList.contains('pp-toast--info')).toBe(true);
      expect(toast.textContent).toContain('Hello');
    });

    it('uses the specified variant class', () => {
      showToast({ message: 'Error!', variant: 'error' });
      const container = document.getElementById('pp-toast-container')!;
      const toast = container.firstElementChild as HTMLElement;
      expect(toast.classList.contains('pp-toast--error')).toBe(true);
    });

    it('defaults to info variant', () => {
      showToast({ message: 'Info' });
      const container = document.getElementById('pp-toast-container')!;
      const toast = container.firstElementChild as HTMLElement;
      expect(toast.classList.contains('pp-toast--info')).toBe(true);
    });

    it('adds pp-toast--visible class after creation', () => {
      showToast({ message: 'Visible' });
      const container = document.getElementById('pp-toast-container')!;
      const toast = container.firstElementChild as HTMLElement;
      expect(toast.classList.contains('pp-toast--visible')).toBe(true);
    });

    it('auto-dismisses after duration', () => {
      showToast({ message: 'Bye', duration: 2000 });
      const container = document.getElementById('pp-toast-container')!;
      expect(container.children.length).toBe(1);

      vi.advanceTimersByTime(2000);
      // After timeout, the toast gets dismissed class and a fallback removal
      vi.advanceTimersByTime(400);
      expect(container.children.length).toBe(0);
    });

    it('uses default 4000ms duration', () => {
      showToast({ message: 'Default' });
      const container = document.getElementById('pp-toast-container')!;
      expect(container.children.length).toBe(1);

      vi.advanceTimersByTime(3999);
      expect(container.children.length).toBe(1);

      vi.advanceTimersByTime(1);
      vi.advanceTimersByTime(400);
      expect(container.children.length).toBe(0);
    });

    it('shows a close button that dismisses the toast', () => {
      showToast({ message: 'Closable' });
      const container = document.getElementById('pp-toast-container')!;
      const closeBtn = container.querySelector('.pp-toast__close') as HTMLButtonElement;
      expect(closeBtn).not.toBeNull();
      expect(closeBtn.getAttribute('aria-label')).toBe('Dismiss notification');

      closeBtn.click();
      vi.advanceTimersByTime(400);
      expect(container.children.length).toBe(0);
    });

    it('renders an action button when provided', () => {
      const onClick = vi.fn();
      showToast({ message: 'With action', action: { label: 'Undo', onClick } });
      const container = document.getElementById('pp-toast-container')!;
      const actionBtn = container.querySelector('.pp-toast__action') as HTMLButtonElement;
      expect(actionBtn).not.toBeNull();
      expect(actionBtn.textContent).toBe('Undo');

      actionBtn.click();
      expect(onClick).toHaveBeenCalledOnce();
      // Action also dismisses the toast
      vi.advanceTimersByTime(400);
      expect(container.children.length).toBe(0);
    });

    it('stacks up to 5 toasts and removes oldest to make room', () => {
      for (let i = 0; i < 6; i++) {
        showToast({ message: `Toast ${i}`, duration: 10000 });
      }
      const container = document.getElementById('pp-toast-container')!;
      // Max 5 visible; the 6th toast replaces the oldest
      expect(container.children.length).toBe(5);
      // The oldest (Toast 0) was removed; Toast 1 should be oldest now
      const messages = Array.from(container.querySelectorAll('.pp-toast__message'))
        .map((el) => el.textContent);
      expect(messages).not.toContain('Toast 0');
      expect(messages).toContain('Toast 5');
    });

    it('does nothing if container is not initialized', () => {
      document.body.innerHTML = ''; // Remove container
      // Should not throw
      expect(() => showToast({ message: 'No container' })).not.toThrow();
    });

    it('sets role=status and aria-atomic on the toast', () => {
      showToast({ message: 'Accessible' });
      const container = document.getElementById('pp-toast-container')!;
      const toast = container.firstElementChild as HTMLElement;
      expect(toast.getAttribute('role')).toBe('status');
      expect(toast.getAttribute('aria-atomic')).toBe('true');
    });

    it('supports all four variants', () => {
      const variants = ['success', 'error', 'warning', 'info'] as const;
      for (const variant of variants) {
        showToast({ message: variant, variant });
      }
      const container = document.getElementById('pp-toast-container')!;
      const toasts = Array.from(container.children) as HTMLElement[];
      expect(toasts[0].classList.contains('pp-toast--success')).toBe(true);
      expect(toasts[1].classList.contains('pp-toast--error')).toBe(true);
      expect(toasts[2].classList.contains('pp-toast--warning')).toBe(true);
      expect(toasts[3].classList.contains('pp-toast--info')).toBe(true);
    });
  });
});
