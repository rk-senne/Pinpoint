// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { lazyRoute } from './router';
import { registerTemplates, _resetLazyTemplatesForTests } from './lazyTemplates';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('lazyRoute', () => {
  it('mounts the loaded handler and forwards its teardown', async () => {
    const node = document.body.appendChild(document.createElement('div'));
    const inner = vi.fn();
    const handler = vi.fn(() => inner);
    const teardown = lazyRoute(async () => handler)(node, { id: '1' }) as () => void;
    await tick();
    expect(handler).toHaveBeenCalledWith(node, { id: '1' });
    teardown();
    expect(inner).toHaveBeenCalled();
  });

  it('skips a stale mount when the user navigated away before the chunk loaded', async () => {
    const node = document.body.appendChild(document.createElement('div'));
    let release!: (h: () => void) => void;
    const slow = lazyRoute(() => new Promise((r) => { release = r; }));
    const handler = vi.fn();
    const teardown = slow(node, {}) as () => void;
    teardown(); // navigated away
    release(handler);
    await tick();
    expect(handler).not.toHaveBeenCalled();
  });

  it('shows a readable error when the chunk fails to load', async () => {
    const node = document.body.appendChild(document.createElement('div'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    lazyRoute(() => Promise.reject(new Error('chunk 404')))(node, {});
    await tick();
    expect(node.textContent).toMatch(/failed to load/i);
  });
});

describe('registerTemplates', () => {
  it('adds templates once and never duplicates an existing id', () => {
    _resetLazyTemplatesForTests();
    registerTemplates('A', '<template id="tpl-lazy-a"><p>a</p></template>');
    registerTemplates('A', '<template id="tpl-lazy-a"><p>a</p></template>');
    registerTemplates('B', '<template id="tpl-lazy-a"><p>dup</p></template>');
    expect(document.querySelectorAll('#tpl-lazy-a')).toHaveLength(1);
    expect((document.getElementById('tpl-lazy-a') as HTMLTemplateElement).content.textContent).toBe('a');
  });
});
