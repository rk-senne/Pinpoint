/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createEmptyState, type EmptyStateType } from './EmptyState';

describe('EmptyState', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('createEmptyState', () => {
    it('returns element with correct structure', () => {
      const el = createEmptyState('no-projects');

      expect(el).toBeInstanceOf(HTMLElement);
      expect(el.className).toBe('pp-empty-state');
      expect(el.getAttribute('role')).toBe('status');

      // Should have illustration, title, description, and CTA
      const illustration = el.querySelector('.pp-empty-state__illustration');
      const title = el.querySelector('.pp-empty-state__title');
      const description = el.querySelector('.pp-empty-state__description');

      expect(illustration).not.toBeNull();
      expect(title).not.toBeNull();
      expect(description).not.toBeNull();

      // SVG should be rendered inside the illustration wrapper
      expect(illustration!.querySelector('svg')).not.toBeNull();
    });

    it('sets correct title and description for no-projects', () => {
      const el = createEmptyState('no-projects');
      const title = el.querySelector('.pp-empty-state__title')!;
      const desc = el.querySelector('.pp-empty-state__description')!;

      expect(title.textContent).toBe('No projects yet');
      expect(desc.textContent).toContain('Create your first project');
    });
  });

  describe('all 6 predefined types produce elements', () => {
    const types: EmptyStateType[] = [
      'no-projects',
      'no-annotations',
      'no-comments',
      'no-teams',
      'no-notifications',
      'no-search-results',
    ];

    types.forEach((type) => {
      it(`creates a valid element for "${type}"`, () => {
        const el = createEmptyState(type);

        expect(el).toBeInstanceOf(HTMLElement);
        expect(el.className).toBe('pp-empty-state');

        // Must have title and description
        const title = el.querySelector('.pp-empty-state__title');
        const description = el.querySelector('.pp-empty-state__description');
        expect(title).not.toBeNull();
        expect(title!.textContent!.length).toBeGreaterThan(0);
        expect(description).not.toBeNull();
        expect(description!.textContent!.length).toBeGreaterThan(0);
      });
    });
  });

  describe('CTA button', () => {
    it('has correct data-action for no-projects', () => {
      const el = createEmptyState('no-projects');
      const button = el.querySelector('.pp-empty-state__cta') as HTMLButtonElement;

      expect(button).not.toBeNull();
      expect(button.getAttribute('data-action')).toBe('createProject');
      expect(button.textContent).toBe('+ Create Project');
      expect(button.type).toBe('button');
    });

    it('has correct data-action for no-teams', () => {
      const el = createEmptyState('no-teams');
      const button = el.querySelector('.pp-empty-state__cta') as HTMLButtonElement;

      expect(button).not.toBeNull();
      expect(button.getAttribute('data-action')).toBe('createTeam');
      expect(button.textContent).toBe('Create Team');
    });

    it('does not render CTA for types without one', () => {
      const el = createEmptyState('no-annotations');
      const button = el.querySelector('.pp-empty-state__cta');

      expect(button).toBeNull();
    });
  });
});
