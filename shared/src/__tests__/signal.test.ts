import { describe, it, expect, vi } from 'vitest';
import { signal } from '../signal.js';

describe('signal', () => {
  describe('get', () => {
    it('returns the initial value', () => {
      const s = signal(42);
      expect(s.get()).toBe(42);
    });

    it('returns the latest value after set', () => {
      const s = signal('a');
      s.set('b');
      expect(s.get()).toBe('b');
    });

    it('handles object references', () => {
      const initial = { count: 0 };
      const s = signal(initial);
      expect(s.get()).toBe(initial);
      const next = { count: 1 };
      s.set(next);
      expect(s.get()).toBe(next);
    });
  });

  describe('set', () => {
    it('updates the stored value', () => {
      const s = signal(0);
      s.set(1);
      s.set(2);
      expect(s.get()).toBe(2);
    });

    it('notifies subscribers when the value changes', () => {
      const s = signal(0);
      const listener = vi.fn();
      s.subscribe(listener);
      listener.mockClear(); // ignore the initial fire

      s.set(1);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(1);

      s.set(2);
      expect(listener).toHaveBeenCalledTimes(2);
      expect(listener).toHaveBeenLastCalledWith(2);
    });

    it('notifies multiple subscribers in subscription order', () => {
      const s = signal(0);
      const calls: string[] = [];
      s.subscribe(() => calls.push('a'));
      s.subscribe(() => calls.push('b'));
      calls.length = 0; // ignore initial fires

      s.set(1);
      expect(calls).toEqual(['a', 'b']);
    });
  });

  describe('Object.is short-circuit', () => {
    it('does not notify subscribers when the value is identical', () => {
      const s = signal(7);
      const listener = vi.fn();
      s.subscribe(listener);
      listener.mockClear();

      s.set(7);
      expect(listener).not.toHaveBeenCalled();
    });

    it('treats NaN as equal to NaN (Object.is semantics)', () => {
      const s = signal<number>(Number.NaN);
      const listener = vi.fn();
      s.subscribe(listener);
      listener.mockClear();

      s.set(Number.NaN);
      expect(listener).not.toHaveBeenCalled();
    });

    it('treats +0 and -0 as distinct (Object.is semantics)', () => {
      const s = signal(0);
      const listener = vi.fn();
      s.subscribe(listener);
      listener.mockClear();

      s.set(-0);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(-0);
    });

    it('does not notify when the same object reference is set', () => {
      const obj = { count: 0 };
      const s = signal(obj);
      const listener = vi.fn();
      s.subscribe(listener);
      listener.mockClear();

      s.set(obj);
      expect(listener).not.toHaveBeenCalled();
    });

    it('notifies when an equal-but-different object is set', () => {
      const s = signal({ count: 0 });
      const listener = vi.fn();
      s.subscribe(listener);
      listener.mockClear();

      // Structurally equal but a new reference — Object.is returns false,
      // so subscribers must be notified.
      s.set({ count: 0 });
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe('subscribe', () => {
    it('fires the listener immediately with the current value', () => {
      const s = signal('hello');
      const listener = vi.fn();
      s.subscribe(listener);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith('hello');
    });

    it('fires the listener immediately with the latest value, not the initial', () => {
      const s = signal(0);
      s.set(99);
      const listener = vi.fn();
      s.subscribe(listener);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(99);
    });
  });

  describe('unsubscribe', () => {
    it('stops notifying after the returned disposer is called', () => {
      const s = signal(0);
      const listener = vi.fn();
      const unsubscribe = s.subscribe(listener);
      listener.mockClear();

      unsubscribe();
      s.set(1);
      expect(listener).not.toHaveBeenCalled();
    });

    it('does not affect other subscribers when one is removed', () => {
      const s = signal(0);
      const a = vi.fn();
      const b = vi.fn();
      const unsubA = s.subscribe(a);
      s.subscribe(b);
      a.mockClear();
      b.mockClear();

      unsubA();
      s.set(1);
      expect(a).not.toHaveBeenCalled();
      expect(b).toHaveBeenCalledWith(1);
    });

    it('is idempotent — calling the disposer twice is safe', () => {
      const s = signal(0);
      const listener = vi.fn();
      const unsubscribe = s.subscribe(listener);

      unsubscribe();
      expect(() => unsubscribe()).not.toThrow();
    });

    it('allows a listener to unsubscribe itself during dispatch without breaking other listeners', () => {
      const s = signal(0);
      let unsubSelf: (() => void) | undefined;
      const a = vi.fn(() => {
        if (unsubSelf) unsubSelf();
      });
      const b = vi.fn();
      unsubSelf = s.subscribe(a);
      s.subscribe(b);
      a.mockClear();
      b.mockClear();

      s.set(1);
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);

      s.set(2);
      expect(a).toHaveBeenCalledTimes(1); // still 1 — it unsubscribed
      expect(b).toHaveBeenCalledTimes(2);
    });
  });
});
