// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { attr, bind, bindEvents, cloneTemplate, mount, requireRole, requireSection, requireSlot, text } from './render';

afterEach(() => {
  document.body.innerHTML = '';
  document.head.querySelectorAll('template').forEach((t) => t.remove());
});

function installTemplate(id: string, html: string): HTMLTemplateElement {
  const tpl = document.createElement('template');
  tpl.id = id;
  tpl.innerHTML = html;
  document.body.appendChild(tpl);
  return tpl;
}

describe('cloneTemplate', () => {
  it('clones the template content into a fresh DocumentFragment', () => {
    installTemplate('row', '<li class="row"><span></span></li>');

    const a = cloneTemplate('row');
    const b = cloneTemplate('row');

    expect(a).toBeInstanceOf(DocumentFragment);
    expect(a.firstElementChild).not.toBe(b.firstElementChild);
    expect((a.firstElementChild as HTMLElement).className).toBe('row');
  });

  it('throws when no template with the given id exists', () => {
    expect(() => cloneTemplate('does-not-exist')).toThrow(
      /no <template> element found with id "does-not-exist"/,
    );
  });

  it('throws when the matched element is not a <template>', () => {
    const div = document.createElement('div');
    div.id = 'not-a-template';
    document.body.appendChild(div);

    expect(() => cloneTemplate('not-a-template')).toThrow(/no <template>/);
  });

  it('fills string slots into matching data-slot elements as textContent', () => {
    installTemplate(
      'card',
      '<article><h2 data-slot="title"></h2><p data-slot="body"></p></article>',
    );

    const fragment = cloneTemplate('card', { title: 'Hello', body: 'World' });
    document.body.appendChild(fragment);

    const article = document.body.querySelector('article')!;
    expect(article.querySelector('[data-slot="title"]')!.textContent).toBe('Hello');
    expect(article.querySelector('[data-slot="body"]')!.textContent).toBe('World');
  });

  it('escapes string values to prevent injection — they become plain text, not markup', () => {
    installTemplate('card', '<div data-slot="body"></div>');

    const fragment = cloneTemplate('card', { body: '<script>alert(1)</script>' });
    document.body.appendChild(fragment);

    const slot = document.body.querySelector('[data-slot="body"]')!;
    expect(slot.querySelector('script')).toBeNull();
    expect(slot.textContent).toBe('<script>alert(1)</script>');
  });

  it('replaces a slot’s children with a Node value', () => {
    installTemplate('card', '<div data-slot="badge">old</div>');

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = '!';

    const fragment = cloneTemplate('card', { badge });
    document.body.appendChild(fragment);

    const slot = document.body.querySelector('[data-slot="badge"]')!;
    expect(slot.children).toHaveLength(1);
    expect(slot.firstElementChild).toBe(badge);
    expect(slot.firstElementChild!.textContent).toBe('!');
  });

  it('fills every matching data-slot element when multiple share a name', () => {
    installTemplate(
      'multi',
      '<div><span data-slot="x"></span><em data-slot="x"></em></div>',
    );

    const fragment = cloneTemplate('multi', { x: 'value' });
    document.body.appendChild(fragment);

    const span = document.body.querySelector('span[data-slot="x"]')!;
    const em = document.body.querySelector('em[data-slot="x"]')!;
    expect(span.textContent).toBe('value');
    expect(em.textContent).toBe('value');
  });

  it('silently ignores slot names that have no matching element', () => {
    installTemplate('card', '<div data-slot="title"></div>');

    expect(() =>
      cloneTemplate('card', { title: 'ok', missing: 'ignored' }),
    ).not.toThrow();
  });

  it('does not mutate the original <template> when cloning', () => {
    const tpl = installTemplate('row', '<li data-slot="label"></li>');

    cloneTemplate('row', { label: 'first' });
    cloneTemplate('row', { label: 'second' });

    const slotInTemplate = tpl.content.querySelector('[data-slot="label"]')!;
    expect(slotInTemplate.textContent).toBe('');
  });
});

describe('bindEvents', () => {
  it('binds click handlers by data-action name', () => {
    const root = document.createElement('div');
    root.innerHTML = '<button data-action="save">Save</button>';
    document.body.appendChild(root);

    const save = vi.fn();
    bindEvents(root, { save });

    (root.querySelector('button') as HTMLButtonElement).click();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toBeInstanceOf(Event);
  });

  it('supports the "event:name" prefix to bind non-click events', () => {
    const root = document.createElement('form');
    root.setAttribute('data-action', 'submit:save');
    root.innerHTML = '<button type="submit"></button>';
    document.body.appendChild(root);

    const save = vi.fn((e: Event) => e.preventDefault());
    bindEvents(root, { save });

    root.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('binds the bare action name as a click event by default', () => {
    const root = document.createElement('div');
    root.innerHTML = '<button data-action="save"></button>';
    document.body.appendChild(root);

    const save = vi.fn();
    bindEvents(root, { save });

    // dispatching a non-click event must not trigger the click-bound handler
    root.querySelector('button')!.dispatchEvent(new Event('input', { bubbles: true }));
    expect(save).not.toHaveBeenCalled();

    (root.querySelector('button') as HTMLButtonElement).click();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('binds handlers on the root element itself when it has data-action', () => {
    const root = document.createElement('button');
    root.setAttribute('data-action', 'go');
    document.body.appendChild(root);

    const go = vi.fn();
    bindEvents(root, { go });

    root.click();
    expect(go).toHaveBeenCalledTimes(1);
  });

  it('skips actions with no matching handler', () => {
    const root = document.createElement('div');
    root.innerHTML =
      '<button data-action="known"></button><button data-action="unknown"></button>';
    document.body.appendChild(root);

    const known = vi.fn();
    expect(() => bindEvents(root, { known })).not.toThrow();

    (root.querySelectorAll('button')[0] as HTMLButtonElement).click();
    (root.querySelectorAll('button')[1] as HTMLButtonElement).click();
    expect(known).toHaveBeenCalledTimes(1);
  });

  it('binds independently to multiple elements sharing the same action name', () => {
    const root = document.createElement('div');
    root.innerHTML =
      '<button data-action="save"></button><button data-action="save"></button>';
    document.body.appendChild(root);

    const save = vi.fn();
    bindEvents(root, { save });

    const buttons = root.querySelectorAll('button');
    (buttons[0] as HTMLButtonElement).click();
    (buttons[1] as HTMLButtonElement).click();
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('returns a cleanup function that removes every listener it registered', () => {
    const root = document.createElement('div');
    root.innerHTML = '<button data-action="save"></button>';
    document.body.appendChild(root);

    const save = vi.fn();
    const cleanup = bindEvents(root, { save });

    const button = root.querySelector('button') as HTMLButtonElement;
    button.click();
    expect(save).toHaveBeenCalledTimes(1);

    cleanup();
    button.click();
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe('text', () => {
  it('sets the element’s textContent', () => {
    const el = document.createElement('span');
    text(el, 'hello');
    expect(el.textContent).toBe('hello');
  });

  it('overwrites previous content rather than appending', () => {
    const el = document.createElement('span');
    el.innerHTML = '<b>old</b>';
    text(el, 'new');
    expect(el.textContent).toBe('new');
    expect(el.querySelector('b')).toBeNull();
  });

  it('treats input as plain text — no HTML interpretation', () => {
    const el = document.createElement('span');
    text(el, '<i>oops</i>');
    expect(el.querySelector('i')).toBeNull();
    expect(el.textContent).toBe('<i>oops</i>');
  });
});

describe('attr', () => {
  it('sets the named attribute', () => {
    const el = document.createElement('a');
    attr(el, 'href', '/projects/42');
    expect(el.getAttribute('href')).toBe('/projects/42');
  });

  it('overwrites a previously-set value', () => {
    const el = document.createElement('a');
    el.setAttribute('href', '/old');
    attr(el, 'href', '/new');
    expect(el.getAttribute('href')).toBe('/new');
  });

  it('writes empty strings as empty (not removed)', () => {
    const el = document.createElement('button');
    attr(el, 'aria-label', '');
    expect(el.getAttribute('aria-label')).toBe('');
    expect(el.hasAttribute('aria-label')).toBe(true);
  });
});

describe('mount', () => {
  it('appends the fragment’s children to the parent in document order', () => {
    const parent = document.createElement('ul');
    const fragment = document.createDocumentFragment();
    const a = document.createElement('li');
    a.textContent = 'a';
    const b = document.createElement('li');
    b.textContent = 'b';
    fragment.append(a, b);

    mount(parent, fragment);

    expect(parent.children).toHaveLength(2);
    expect(parent.firstElementChild).toBe(a);
    expect(parent.lastElementChild).toBe(b);
  });

  it('empties the fragment after mounting (children are moved, not copied)', () => {
    const parent = document.createElement('div');
    const fragment = document.createDocumentFragment();
    fragment.appendChild(document.createElement('span'));

    mount(parent, fragment);

    expect(fragment.childNodes).toHaveLength(0);
    expect(parent.children).toHaveLength(1);
  });

  it('appends after existing children rather than replacing them', () => {
    const parent = document.createElement('div');
    const existing = document.createElement('p');
    existing.textContent = 'first';
    parent.appendChild(existing);

    const fragment = document.createDocumentFragment();
    const added = document.createElement('p');
    added.textContent = 'second';
    fragment.appendChild(added);

    mount(parent, fragment);

    expect(parent.children).toHaveLength(2);
    expect(parent.firstElementChild).toBe(existing);
    expect(parent.lastElementChild).toBe(added);
  });

  it('mounts a fragment produced by cloneTemplate into a real parent', () => {
    installTemplate('greeting', '<p data-slot="who"></p>');
    const parent = document.createElement('section');
    document.body.appendChild(parent);

    const fragment = cloneTemplate('greeting', { who: 'world' });
    mount(parent, fragment);

    expect(parent.querySelector('p')!.textContent).toBe('world');
  });
});

describe('bind', () => {
  function makeSignal<T>(initial: T) {
    let value = initial;
    const listeners = new Set<(v: T) => void>();
    return {
      get: () => value,
      set(next: T) {
        if (Object.is(value, next)) return;
        value = next;
        for (const fn of [...listeners]) fn(value);
      },
      subscribe(fn: (v: T) => void) {
        listeners.add(fn);
        fn(value);
        return () => {
          listeners.delete(fn);
        };
      },
    };
  }

  it('runs the updater immediately with the signal’s current value', () => {
    const host = document.createElement('span');
    const sig = makeSignal('hello');
    const updater = vi.fn((el: Element, v: string) => {
      el.textContent = v;
    });

    bind(host, sig, updater);

    expect(updater).toHaveBeenCalledTimes(1);
    expect(updater.mock.calls[0][0]).toBe(host);
    expect(updater.mock.calls[0][1]).toBe('hello');
    expect(host.textContent).toBe('hello');
  });

  it('re-runs the updater whenever the signal fires', () => {
    const host = document.createElement('span');
    const sig = makeSignal(0);
    const updater = vi.fn((el: Element, v: number) => {
      el.textContent = String(v);
    });

    bind(host, sig, updater);
    sig.set(1);
    sig.set(2);

    expect(updater).toHaveBeenCalledTimes(3);
    expect(host.textContent).toBe('2');
  });

  it('returns an unsubscribe function that stops further updates', () => {
    const host = document.createElement('span');
    const sig = makeSignal('a');
    const updater = vi.fn((el: Element, v: string) => {
      el.textContent = v;
    });

    const unsubscribe = bind(host, sig, updater);
    expect(host.textContent).toBe('a');

    unsubscribe();
    sig.set('b');

    expect(updater).toHaveBeenCalledTimes(1);
    expect(host.textContent).toBe('a');
  });

  it('passes the host element identity through to every updater call', () => {
    const host = document.createElement('div');
    const sig = makeSignal(1);
    const seenHosts: Element[] = [];

    bind(host, sig, (el) => {
      seenHosts.push(el);
    });
    sig.set(2);

    expect(seenHosts).toHaveLength(2);
    expect(seenHosts[0]).toBe(host);
    expect(seenHosts[1]).toBe(host);
  });
});

describe('requireSection / requireRole / requireSlot', () => {
  it('requireSection returns the matching [data-section] element', () => {
    const root = document.createElement('div');
    root.innerHTML = '<section data-section="profile">hi</section>';

    const el = requireSection(root, 'profile');
    expect(el.tagName).toBe('SECTION');
  });

  it('requireSection throws when the element is missing', () => {
    const root = document.createElement('div');
    expect(() => requireSection(root, 'profile')).toThrow(
      /Template is missing the "profile" section/,
    );
  });

  it('requireRole returns the matching [data-role] element', () => {
    const root = document.createElement('div');
    root.innerHTML = '<button data-role="submit">Go</button>';

    const el = requireRole(root, 'submit');
    expect(el.tagName).toBe('BUTTON');
  });

  it('requireRole throws when the element is missing', () => {
    const root = document.createElement('div');
    expect(() => requireRole(root, 'submit')).toThrow(
      /Template is missing \[data-role="submit"\]/,
    );
  });

  it('requireSlot returns the matching [data-slot] element', () => {
    const root = document.createElement('div');
    root.innerHTML = '<span data-slot="title">Hello</span>';

    const el = requireSlot(root, 'title');
    expect(el.tagName).toBe('SPAN');
  });

  it('requireSlot throws when the element is missing', () => {
    const root = document.createElement('div');
    expect(() => requireSlot(root, 'title')).toThrow(
      /Template is missing \[data-slot="title"\]/,
    );
  });
});
