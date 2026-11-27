// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderRemoteCursor, startCursorBroadcast } from './liveCursors';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z')); });
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; });

describe('startCursorBroadcast', () => {
  it('emits cursor:move with page coordinates, throttled to one per 100 ms', () => {
    const emit = vi.fn();
    const stop = startCursorBroadcast({ emit }, { userId: 'u1', email: 'a@b.test' });
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 10, clientY: 20 }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 11, clientY: 21 }));
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('cursor:move', expect.objectContaining({ userId: 'u1', x: 10, y: 20 }));
    vi.advanceTimersByTime(100);
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 12, clientY: 22 }));
    expect(emit).toHaveBeenCalledTimes(2);
    stop();
    vi.advanceTimersByTime(500);
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 1, clientY: 1 }));
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('never leaks secrets from the page URL into the broadcast', () => {
    const emit = vi.fn();
    window.history.replaceState({}, '', '/page?token=SECRET#frag');
    startCursorBroadcast({ emit }, { userId: 'u1', email: 'a@b.test' });
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 1, clientY: 1 }));
    const sent = (emit.mock.calls[0]![1] as { pageUrl: string }).pageUrl;
    expect(sent).not.toContain('SECRET');
    expect(sent).not.toContain('#frag');
    window.history.replaceState({}, '', '/');
  });
});

describe('renderRemoteCursor', () => {
  it('renders a labelled, non-interactive cursor and removes it on cleanup', () => {
    const remove = renderRemoteCursor({ userId: 'u2', name: 'Dana', x: 5, y: 6, pageUrl: 'https://x.test/' });
    const el = document.querySelector<HTMLElement>('.pinpoint-remote-cursor')!;
    expect(el.dataset.user).toBe('u2');
    expect(el.textContent).toBe('Dana');
    expect(el.style.left).toBe('5px');
    expect(el.style.pointerEvents).toBe('none');
    remove();
    expect(document.querySelector('.pinpoint-remote-cursor')).toBeNull();
  });

  it('falls back to the e-mail local part, then to "Teammate"', () => {
    renderRemoteCursor({ userId: 'u3', email: 'sam@example.test', x: 0, y: 0, pageUrl: '' });
    renderRemoteCursor({ userId: 'u4', x: 0, y: 0, pageUrl: '' });
    const labels = [...document.querySelectorAll('.pinpoint-remote-cursor')].map((e) => e.textContent);
    expect(labels).toEqual(['sam', 'Teammate']);
  });
});
