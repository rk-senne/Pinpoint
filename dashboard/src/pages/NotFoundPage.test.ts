// @vitest-environment jsdom
/**
 * Unit tests for `mountNotFoundPage` (GAP 2 — UI coverage).
 *
 * The 404 page is a pure template-clone: it looks up the `#not-found-page`
 * `<template>` from `index.html` and appends its content to the root. These
 * tests exercise mount/render (the heading + home link land in the root), the
 * "home link" primary affordance, and the empty/error state (no template in
 * the document → no-op, no throw).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mountNotFoundPage } from './NotFoundPage';

// Mirror only the structure NotFoundPage renders (see dashboard/index.html).
// The `data-route` link and the "404"/"Page not found" copy are the public
// contract the page relies on.
const NOT_FOUND_TEMPLATE = `
  <div>
    <div>
      <h1>404</h1>
      <p>Page not found</p>
      <a href="/" data-route>← Back to Dashboard</a>
    </div>
  </div>
`;

function installTemplate(): void {
  const tpl = document.createElement('template');
  tpl.id = 'not-found-page';
  tpl.innerHTML = NOT_FOUND_TEMPLATE;
  document.body.appendChild(tpl);
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('mountNotFoundPage', () => {
  describe('render', () => {
    it('clones the 404 template into the root element', () => {
      installTemplate();
      const root = document.createElement('div');
      document.body.appendChild(root);

      mountNotFoundPage(root);

      expect(root.querySelector('h1')?.textContent).toBe('404');
      expect(root.querySelector('p')?.textContent).toBe('Page not found');
    });

    it('renders a home link pointing at "/" (the primary affordance)', () => {
      installTemplate();
      const root = document.createElement('div');
      document.body.appendChild(root);

      mountNotFoundPage(root);

      const link = root.querySelector('a');
      expect(link).not.toBeNull();
      expect(link!.getAttribute('href')).toBe('/');
      // `data-route` marks it for the History-API router to intercept.
      expect(link!.hasAttribute('data-route')).toBe(true);
    });
  });

  describe('empty / error state', () => {
    it('is a no-op (no throw, no mutation) when the template is absent', () => {
      const root = document.createElement('div');
      document.body.appendChild(root);

      expect(() => mountNotFoundPage(root)).not.toThrow();
      expect(root.childNodes.length).toBe(0);
    });
  });
});
