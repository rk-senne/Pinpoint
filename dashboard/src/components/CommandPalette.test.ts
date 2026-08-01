// @vitest-environment jsdom
/**
 * CommandPalette.test.ts — unit tests for the global command palette.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mountCommandPalette } from './CommandPalette';
import { projectsStore, loadProjects } from '../lib/stores';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupTemplate(): void {
  const tpl = document.createElement('template');
  tpl.id = 'tpl-command-palette';
  tpl.innerHTML = `
    <div data-role="backdrop" style="position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 9999; display: flex; align-items: flex-start; justify-content: center; padding-top: 20vh;">
      <div data-role="panel" role="dialog" aria-modal="true" aria-label="Command palette" style="background: #fff; border-radius: 12px; width: 100%; max-width: 560px; overflow: hidden;">
        <div style="padding: 12px 16px; border-bottom: 1px solid #e5e7eb;">
          <input data-role="search-input" type="text" placeholder="Search projects, actions..." style="width: 100%; border: none; outline: none; font-size: 16px;" />
        </div>
        <div data-role="results" style="max-height: 360px; overflow-y: auto; padding: 8px;"></div>
        <div style="padding: 8px 16px; border-top: 1px solid #e5e7eb; font-size: 12px;">
          <kbd>↑↓</kbd> navigate · <kbd>↵</kbd> select · <kbd>esc</kbd> close
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(tpl);
}

function pressKey(
  key: string,
  opts: Partial<KeyboardEventInit> = {},
): void {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...opts,
  });
  document.dispatchEvent(event);
}

function inputText(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function getBackdrop(): HTMLElement | null {
  return document.querySelector('[data-role="backdrop"]');
}

function getSearchInput(): HTMLInputElement | null {
  return document.querySelector('[data-role="search-input"]') as HTMLInputElement | null;
}

function getResultRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll('[data-palette-index]'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('mountCommandPalette', () => {
  let teardown: () => void;

  beforeEach(() => {
    setupTemplate();
    // Seed some projects
    loadProjects([
      { id: '1', name: 'Alpha Project', urls: [], status: 'active', ownerId: 'u1', createdAt: '', updatedAt: '' },
      { id: '2', name: 'Beta Project', urls: [], status: 'active', ownerId: 'u1', createdAt: '', updatedAt: '' },
      { id: '3', name: 'Gamma Archived', urls: [], status: 'archived', ownerId: 'u1', createdAt: '', updatedAt: '' },
    ]);
    teardown = mountCommandPalette(document.body);
  });

  afterEach(() => {
    teardown();
    document.body.innerHTML = '';
    loadProjects([]);
  });

  it('does not show the palette initially', () => {
    expect(getBackdrop()).toBeNull();
  });

  it('opens on Ctrl+K', () => {
    pressKey('k', { ctrlKey: true });
    expect(getBackdrop()).not.toBeNull();
    expect(getSearchInput()).not.toBeNull();
  });

  it('opens on Meta+K (Mac shortcut)', () => {
    pressKey('k', { metaKey: true });
    expect(getBackdrop()).not.toBeNull();
  });

  it('closes on Escape', () => {
    pressKey('k', { ctrlKey: true });
    expect(getBackdrop()).not.toBeNull();
    pressKey('Escape');
    expect(getBackdrop()).toBeNull();
  });

  it('closes when clicking the backdrop', () => {
    pressKey('k', { ctrlKey: true });
    const backdrop = getBackdrop()!;
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(getBackdrop()).toBeNull();
  });

  it('shows all projects and actions when opened with no filter', () => {
    pressKey('k', { ctrlKey: true });
    const rows = getResultRows();
    // 3 projects + 4 static actions = 7
    expect(rows.length).toBe(7);
  });

  it('filters results by query (case-insensitive)', () => {
    pressKey('k', { ctrlKey: true });
    const input = getSearchInput()!;
    inputText(input, 'alpha');
    const rows = getResultRows();
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toBe('Alpha Project');
  });

  it('filters actions by query', () => {
    pressKey('k', { ctrlKey: true });
    const input = getSearchInput()!;
    inputText(input, 'settings');
    const rows = getResultRows();
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toBe('Settings');
  });

  it('shows empty state when nothing matches', () => {
    pressKey('k', { ctrlKey: true });
    const input = getSearchInput()!;
    inputText(input, 'zzzzz');
    const rows = getResultRows();
    expect(rows.length).toBe(0);
    const results = document.querySelector('[data-role="results"]')!;
    expect(results.textContent).toContain('No results found');
  });

  it('navigates with arrow keys', () => {
    pressKey('k', { ctrlKey: true });
    const input = getSearchInput()!;

    // First row should be selected by default
    let rows = getResultRows();
    expect(rows[0].getAttribute('aria-selected')).toBe('true');

    // Move down
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    rows = getResultRows();
    expect(rows[0].getAttribute('aria-selected')).toBe('false');
    expect(rows[1].getAttribute('aria-selected')).toBe('true');

    // Move up wraps to last
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    rows = getResultRows();
    expect(rows[0].getAttribute('aria-selected')).toBe('true');
  });

  it('executes item on Enter and closes the palette', () => {
    pressKey('k', { ctrlKey: true });
    const input = getSearchInput()!;
    inputText(input, 'Settings');

    // Press Enter on the selected (first) item
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    // Palette should close
    expect(getBackdrop()).toBeNull();
    // Should have navigated to /settings
    expect(location.pathname).toBe('/settings');
  });

  it('executes project item and navigates to /projects/:id', () => {
    pressKey('k', { ctrlKey: true });
    const input = getSearchInput()!;
    inputText(input, 'Beta');

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(getBackdrop()).toBeNull();
    expect(location.pathname).toBe('/projects/2');
  });

  it('toggles closed with Ctrl+K when open', () => {
    pressKey('k', { ctrlKey: true });
    expect(getBackdrop()).not.toBeNull();
    pressKey('k', { ctrlKey: true });
    expect(getBackdrop()).toBeNull();
  });

  it('teardown removes the global listener', () => {
    teardown();
    pressKey('k', { ctrlKey: true });
    expect(getBackdrop()).toBeNull();
    // Re-assign so afterEach doesn't double-call
    teardown = () => {};
  });

  it('includes archived projects in results', () => {
    pressKey('k', { ctrlKey: true });
    const input = getSearchInput()!;
    inputText(input, 'Gamma');
    const rows = getResultRows();
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toBe('Gamma Archived');
  });
});
