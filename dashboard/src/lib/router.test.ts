// @vitest-environment jsdom
/**
 * Unit tests for the tiny dashboard router.
 *
 * Validates: Requirements 31.1
 *
 * Covers:
 * - Static path matching and handler invocation with the registered root.
 * - `:param` parsing (single, multiple, decoded).
 * - Trailing-slash tolerance.
 * - First-match-wins ordering.
 * - `navigate()` updates `history` and re-runs the matcher.
 * - `popstate` triggers re-resolution.
 * - `<a data-route>` clicks are intercepted; plain links are not.
 * - Modifier-key clicks (cmd/ctrl/shift/alt, middle-click, target=_blank) are not intercepted.
 * - Cross-origin `<a data-route>` clicks are not intercepted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  defineRoute,
  navigate,
  start,
  _resetRouterForTests,
} from './router';

let root: HTMLElement;

beforeEach(() => {
  _resetRouterForTests();
  history.replaceState(null, '', '/');
  document.body.innerHTML = '';
  root = document.createElement('div');
  document.body.appendChild(root);
});

afterEach(() => {
  _resetRouterForTests();
});

describe('defineRoute + start', () => {
  it('invokes the handler for a static path with the registered root', () => {
    const handler = vi.fn();
    defineRoute('/dashboard', handler);
    history.replaceState(null, '', '/dashboard');
    start(root);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(root, {});
  });

  it('parses a single :param', () => {
    const handler = vi.fn();
    defineRoute('/projects/:id', handler);
    history.replaceState(null, '', '/projects/abc-123');
    start(root);
    expect(handler).toHaveBeenCalledWith(root, { id: 'abc-123' });
  });

  it('parses multiple :params', () => {
    const handler = vi.fn();
    defineRoute('/teams/:teamId/members/:userId', handler);
    history.replaceState(null, '', '/teams/t1/members/u9');
    start(root);
    expect(handler).toHaveBeenCalledWith(root, { teamId: 't1', userId: 'u9' });
  });

  it('decodes percent-encoded :param values', () => {
    const handler = vi.fn();
    defineRoute('/shared/:linkId', handler);
    history.replaceState(null, '', '/shared/hello%20world');
    start(root);
    expect(handler).toHaveBeenCalledWith(root, { linkId: 'hello world' });
  });

  it('tolerates a trailing slash', () => {
    const handler = vi.fn();
    defineRoute('/projects/:id', handler);
    history.replaceState(null, '', '/projects/42/');
    start(root);
    expect(handler).toHaveBeenCalledWith(root, { id: '42' });
  });

  it('uses the first matching route', () => {
    const first = vi.fn();
    const second = vi.fn();
    defineRoute('/projects/:id', first);
    defineRoute('/projects/:id', second);
    history.replaceState(null, '', '/projects/9');
    start(root);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('does not invoke any handler when no pattern matches', () => {
    const handler = vi.fn();
    defineRoute('/projects/:id', handler);
    history.replaceState(null, '', '/unknown');
    start(root);
    expect(handler).not.toHaveBeenCalled();
  });

  it('clears the root before each render so handlers start with an empty node', () => {
    defineRoute('/page', (node) => {
      const span = document.createElement('span');
      span.textContent = 'hi';
      node.appendChild(span);
    });
    history.replaceState(null, '', '/page');
    start(root);
    expect(root.children).toHaveLength(1);
    // Re-resolving (e.g. via navigate to the same path) should not double up.
    navigate('/page');
    expect(root.children).toHaveLength(1);
  });
});

describe('teardown handling', () => {
  it('invokes the teardown returned by the previous handler before mounting the next route', () => {
    const teardown = vi.fn();
    const homeHandler = vi.fn().mockReturnValue(teardown);
    const projectHandler = vi.fn();
    defineRoute('/', homeHandler);
    defineRoute('/projects/:id', projectHandler);

    history.replaceState(null, '', '/');
    start(root);
    expect(homeHandler).toHaveBeenCalledTimes(1);
    expect(teardown).not.toHaveBeenCalled();

    navigate('/projects/abc');
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(projectHandler).toHaveBeenCalledTimes(1);
  });

  it('continues navigation even when the teardown throws', () => {
    const teardown = vi.fn(() => {
      throw new Error('boom');
    });
    const home = vi.fn().mockReturnValue(teardown);
    const next = vi.fn();
    defineRoute('/', home);
    defineRoute('/next', next);

    history.replaceState(null, '', '/');
    start(root);
    expect(() => navigate('/next')).not.toThrow();
    expect(teardown).toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('navigate', () => {
  it('pushes a new history entry and re-runs the matcher', () => {
    const home = vi.fn();
    const project = vi.fn();
    defineRoute('/', home);
    defineRoute('/projects/:id', project);
    start(root);
    expect(home).toHaveBeenCalledTimes(1);

    navigate('/projects/77');
    expect(location.pathname).toBe('/projects/77');
    expect(project).toHaveBeenCalledWith(root, { id: '77' });
  });
});

describe('popstate', () => {
  it('re-resolves the current path on popstate', () => {
    const a = vi.fn();
    const b = vi.fn();
    defineRoute('/a', a);
    defineRoute('/b', b);
    history.replaceState(null, '', '/a');
    start(root);
    expect(a).toHaveBeenCalledTimes(1);

    history.replaceState(null, '', '/b');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(b).toHaveBeenCalledTimes(1);
  });
});

describe('link interception', () => {
  it('intercepts left-clicks on <a data-route> and calls navigate', () => {
    const home = vi.fn();
    const target = vi.fn();
    defineRoute('/', home);
    defineRoute('/target', target);
    start(root);

    const link = document.createElement('a');
    link.href = '/target';
    link.setAttribute('data-route', '');
    document.body.appendChild(link);

    const evt = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(evt);

    expect(evt.defaultPrevented).toBe(true);
    expect(location.pathname).toBe('/target');
    expect(target).toHaveBeenCalledWith(root, {});
  });

  it('does NOT intercept anchors without data-route', () => {
    defineRoute('/', vi.fn());
    start(root);

    const link = document.createElement('a');
    link.href = '/elsewhere';
    document.body.appendChild(link);

    const evt = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(evt);

    expect(evt.defaultPrevented).toBe(false);
  });

  it('does NOT intercept modifier-key or non-left-button clicks', () => {
    defineRoute('/', vi.fn());
    start(root);

    const link = document.createElement('a');
    link.href = '/somewhere';
    link.setAttribute('data-route', '');
    document.body.appendChild(link);

    for (const init of [
      { button: 1 } as MouseEventInit, // middle-click
      { button: 0, metaKey: true } as MouseEventInit,
      { button: 0, ctrlKey: true } as MouseEventInit,
      { button: 0, shiftKey: true } as MouseEventInit,
      { button: 0, altKey: true } as MouseEventInit,
    ]) {
      const evt = new MouseEvent('click', { bubbles: true, cancelable: true, ...init });
      link.dispatchEvent(evt);
      expect(evt.defaultPrevented).toBe(false);
    }
  });

  it('does NOT intercept target="_blank" links', () => {
    defineRoute('/', vi.fn());
    start(root);

    const link = document.createElement('a');
    link.href = '/elsewhere';
    link.target = '_blank';
    link.setAttribute('data-route', '');
    document.body.appendChild(link);

    const evt = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(evt);

    expect(evt.defaultPrevented).toBe(false);
  });

  it('does NOT intercept cross-origin links', () => {
    defineRoute('/', vi.fn());
    start(root);

    const link = document.createElement('a');
    link.href = 'https://example.com/elsewhere';
    link.setAttribute('data-route', '');
    document.body.appendChild(link);

    const evt = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(evt);

    expect(evt.defaultPrevented).toBe(false);
  });

  it('matches data-route on a nested element via closest()', () => {
    const target = vi.fn();
    defineRoute('/', vi.fn());
    defineRoute('/nested', target);
    start(root);

    const link = document.createElement('a');
    link.href = '/nested';
    link.setAttribute('data-route', '');
    const child = document.createElement('span');
    link.appendChild(child);
    document.body.appendChild(link);

    const evt = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    child.dispatchEvent(evt);

    expect(location.pathname).toBe('/nested');
    expect(target).toHaveBeenCalledTimes(1);
  });
});
