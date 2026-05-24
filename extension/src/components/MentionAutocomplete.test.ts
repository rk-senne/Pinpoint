// @vitest-environment jsdom
/**
 * Unit tests for `<fl-mention-autocomplete>` (Requirement 31.3, task 17.4).
 *
 * Covers the contract called out in the task:
 *   1. The element is a Custom Element subclass of HTMLElement with an open
 *      Shadow Root and adopts the shared stylesheet (or its <style> fallback).
 *   2. `members` and `query` properties trigger a re-render.
 *   3. Filtering delegates to `filterMentionCandidates` from
 *      `lib/mentionFilter.ts` (Property 2 invariant — same case-insensitive
 *      substring semantics as the property-based test).
 *   4. Clicking a row dispatches a bubbling+composed `select` CustomEvent
 *      with `{ detail: { member } }`.
 *
 * The underlying `mentionFilter` module is intentionally untouched, so the
 * existing property test in `__tests__/properties/mentionFilter.property.test.ts`
 * continues to govern correctness of the filter itself.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FlMentionAutocomplete } from './MentionAutocomplete';
import type { MentionCandidate } from '../lib/mentionFilter';

function makeMember(overrides: Partial<MentionCandidate> = {}): MentionCandidate {
  return {
    userId: overrides.userId ?? crypto.randomUUID(),
    name: overrides.name ?? 'Alice Example',
    email: overrides.email ?? 'alice@example.com',
  };
}

function mount(): FlMentionAutocomplete {
  const el = document.createElement('fl-mention-autocomplete') as FlMentionAutocomplete;
  document.body.appendChild(el);
  return el;
}

function rows(el: FlMentionAutocomplete): HTMLElement[] {
  return Array.from(
    el.shadowRoot!.querySelectorAll<HTMLElement>('li.fl-mention-item'),
  );
}

describe('<fl-mention-autocomplete>', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('is registered as a Custom Element', () => {
    expect(customElements.get('fl-mention-autocomplete')).toBe(FlMentionAutocomplete);
  });

  it('extends HTMLElement and attaches an open Shadow Root', () => {
    const el = mount();
    expect(el).toBeInstanceOf(HTMLElement);
    expect(el.shadowRoot).not.toBeNull();
    expect(el.shadowRoot?.mode).toBe('open');
  });

  it('adopts the shared stylesheet (or its <style> fallback) so theme rules are in scope', () => {
    const el = mount();
    const root = el.shadowRoot!;
    const hasAdopted =
      Array.isArray(root.adoptedStyleSheets) && root.adoptedStyleSheets.length > 0;
    const hasFallbackStyle = root.querySelector('style') !== null;
    expect(hasAdopted || hasFallbackStyle).toBe(true);
  });

  it('renders nothing and is hidden when there are no members', () => {
    const el = mount();
    expect(el.hidden).toBe(true);
    expect(rows(el)).toHaveLength(0);
  });

  it('renders one row per member when query is empty', () => {
    const el = mount();
    el.members = [
      makeMember({ userId: 'u1', name: 'Alice', email: 'alice@example.com' }),
      makeMember({ userId: 'u2', name: 'Bob', email: 'bob@example.com' }),
      makeMember({ userId: 'u3', name: 'Carol', email: 'carol@example.com' }),
    ];

    expect(el.hidden).toBe(false);
    const ol = el.shadowRoot!.querySelector('ol.fl-mention-dropdown') as HTMLOListElement;
    expect(ol).toBeTruthy();
    expect(ol.hidden).toBe(false);

    const rendered = rows(el);
    expect(rendered).toHaveLength(3);
    expect(rendered[0].querySelector('.fl-mention-name')!.textContent).toBe('Alice');
    expect(rendered[0].querySelector('.fl-mention-email')!.textContent).toBe(
      'alice@example.com',
    );
    expect(rendered[0].dataset.userId).toBe('u1');
  });

  it('filters by case-insensitive substring against name and email (matches lib/mentionFilter)', () => {
    const el = mount();
    el.members = [
      makeMember({ userId: 'u1', name: 'Alice Example', email: 'alice@example.com' }),
      makeMember({ userId: 'u2', name: 'Bob Builder', email: 'bob@example.com' }),
      makeMember({ userId: 'u3', name: 'Carol', email: 'carol@somewhere.com' }),
    ];

    el.query = 'BoB';
    let rendered = rows(el);
    expect(rendered).toHaveLength(1);
    expect(rendered[0].dataset.userId).toBe('u2');

    el.query = 'example.com';
    rendered = rows(el);
    expect(rendered.map((r) => r.dataset.userId)).toEqual(['u1', 'u2']);

    el.query = 'no-match-token';
    expect(rows(el)).toHaveLength(0);
    expect(el.hidden).toBe(true);
  });

  it('re-renders after every property assignment', () => {
    const el = mount();
    el.members = [
      makeMember({ userId: 'u1', name: 'Alice', email: 'alice@a.com' }),
    ];
    expect(rows(el)).toHaveLength(1);

    el.members = [
      makeMember({ userId: 'u1', name: 'Alice', email: 'alice@a.com' }),
      makeMember({ userId: 'u2', name: 'Bob', email: 'bob@b.com' }),
    ];
    expect(rows(el)).toHaveLength(2);

    el.query = 'al';
    expect(rows(el).map((r) => r.dataset.userId)).toEqual(['u1']);

    el.query = '';
    expect(rows(el)).toHaveLength(2);
  });

  it('returns empty list / hides itself when query matches no member', () => {
    const el = mount();
    el.members = [makeMember({ name: 'Alice' })];
    el.query = 'xyz';

    expect(rows(el)).toHaveLength(0);
    expect(el.hidden).toBe(true);
    const ol = el.shadowRoot!.querySelector('ol.fl-mention-dropdown') as HTMLOListElement;
    expect(ol.hidden).toBe(true);
  });

  it('emits a bubbling, composed `select` CustomEvent with the chosen member on click', () => {
    const el = mount();
    const alice = makeMember({ userId: 'u-alice', name: 'Alice', email: 'alice@example.com' });
    const bob = makeMember({ userId: 'u-bob', name: 'Bob', email: 'bob@example.com' });
    el.members = [alice, bob];

    const seen: CustomEvent<{ member: MentionCandidate }>[] = [];
    document.addEventListener('select', (e) => {
      seen.push(e as CustomEvent<{ member: MentionCandidate }>);
    });

    const rendered = rows(el);
    rendered[1].click();

    expect(seen).toHaveLength(1);
    const evt = seen[0];
    expect(evt.bubbles).toBe(true);
    expect(evt.composed).toBe(true);
    expect(evt.detail).toEqual({ member: bob });
  });

  it('resolves the clicked member via data-user-id even when the click hits an inner element', () => {
    const el = mount();
    const carol = makeMember({ userId: 'u-carol', name: 'Carol', email: 'carol@example.com' });
    el.members = [carol];

    let detail: { member: MentionCandidate } | undefined;
    el.addEventListener('select', (e) => {
      detail = (e as CustomEvent<{ member: MentionCandidate }>).detail;
    });

    // Click the inner <strong> rather than the row itself — the delegated
    // handler must walk up to the .fl-mention-item ancestor.
    const inner = rows(el)[0].querySelector('.fl-mention-name') as HTMLElement;
    inner.click();

    expect(detail).toEqual({ member: carol });
  });

  it('does not dispatch `select` when a click lands outside any row', () => {
    const el = mount();
    el.members = [makeMember({ userId: 'u1', name: 'Alice' })];

    let count = 0;
    el.addEventListener('select', () => count++);

    // Click the <ol> background between rows.
    const ol = el.shadowRoot!.querySelector('ol.fl-mention-dropdown') as HTMLOListElement;
    ol.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));

    expect(count).toBe(0);
  });

  it('reads back the assigned values via the `members` and `query` getters', () => {
    const el = mount();
    const list = [makeMember({ userId: 'a' }), makeMember({ userId: 'b' })];
    el.members = list;
    el.query = 'q';
    expect(el.members.map((m) => m.userId)).toEqual(['a', 'b']);
    expect(el.query).toBe('q');
  });

  it('treats null / undefined `members` and `query` as empty', () => {
    const el = mount();
    el.members = [makeMember()];
    el.query = 'x';

    el.members = null as unknown as readonly MentionCandidate[];
    expect(el.members).toEqual([]);

    el.query = undefined as unknown as string;
    expect(el.query).toBe('');
  });

  it('omits the email span when a member has no email', () => {
    const el = mount();
    el.members = [makeMember({ userId: 'u1', name: 'NoEmail', email: '' })];
    const row = rows(el)[0];
    expect(row.querySelector('.fl-mention-name')!.textContent).toBe('NoEmail');
    expect(row.querySelector('.fl-mention-email')).toBeNull();
  });

  describe('ARIA + keyboard navigation', () => {
    it('exposes role="listbox" with a unique id on the inner <ol> and an option id per row', () => {
      const el = mount();
      el.members = [
        makeMember({ userId: 'u1' }),
        makeMember({ userId: 'u2' }),
      ];

      const ol = el.shadowRoot!.querySelector('ol.fl-mention-dropdown') as HTMLOListElement;
      expect(ol.getAttribute('role')).toBe('listbox');
      expect(ol.id).toBeTruthy();
      expect(ol.id).toBe(el.listboxId);

      const items = rows(el);
      expect(items).toHaveLength(2);
      for (const li of items) {
        expect(li.getAttribute('role')).toBe('option');
        expect(li.id).toBeTruthy();
        expect(li.id.startsWith(`${el.listboxId}-option-`)).toBe(true);
      }
      expect(items[0].id).not.toBe(items[1].id);
    });

    it('highlights the first option by default and exposes its id via activeOptionId', () => {
      const el = mount();
      el.members = [
        makeMember({ userId: 'u1' }),
        makeMember({ userId: 'u2' }),
      ];
      const items = rows(el);
      expect(items[0].getAttribute('aria-selected')).toBe('true');
      expect(items[1].getAttribute('aria-selected')).toBe('false');
      expect(el.activeOptionId).toBe(items[0].id);
      expect(el.highlightedMember?.userId).toBe('u1');
    });

    it('returns null activeOptionId when there are no candidates', () => {
      const el = mount();
      expect(el.activeOptionId).toBeNull();
      expect(el.highlightedMember).toBeNull();
    });

    it('moves the highlight with ArrowDown / ArrowUp via handleKeydown', () => {
      const el = mount();
      el.members = [
        makeMember({ userId: 'u1' }),
        makeMember({ userId: 'u2' }),
        makeMember({ userId: 'u3' }),
      ];

      const handled1 = el.handleKeydown(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
      expect(handled1).toBe(true);
      expect(el.highlightedMember?.userId).toBe('u2');

      const items = rows(el);
      expect(items[1].getAttribute('aria-selected')).toBe('true');
      expect(items[0].getAttribute('aria-selected')).toBe('false');

      el.handleKeydown(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
      expect(el.highlightedMember?.userId).toBe('u3');

      // Wrap-around past the end.
      el.handleKeydown(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
      expect(el.highlightedMember?.userId).toBe('u1');

      // ArrowUp wraps to the end.
      el.handleKeydown(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
      expect(el.highlightedMember?.userId).toBe('u3');
    });

    it('Enter dispatches a `select` for the highlighted member and returns true', () => {
      const el = mount();
      const m1 = makeMember({ userId: 'u1' });
      const m2 = makeMember({ userId: 'u2' });
      el.members = [m1, m2];

      const seen: MentionCandidate[] = [];
      el.addEventListener('select', (e) => {
        seen.push((e as CustomEvent<{ member: MentionCandidate }>).detail.member);
      });

      el.handleKeydown(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
      const handled = el.handleKeydown(new KeyboardEvent('keydown', { key: 'Enter' }));
      expect(handled).toBe(true);
      expect(seen).toHaveLength(1);
      expect(seen[0].userId).toBe('u2');
    });

    it('Escape hides the dropdown and emits a `cancel` CustomEvent', () => {
      const el = mount();
      el.members = [makeMember({ userId: 'u1' })];
      expect(el.hidden).toBe(false);

      let cancelCount = 0;
      const evts: Event[] = [];
      el.addEventListener('cancel', (e) => {
        cancelCount += 1;
        evts.push(e);
      });

      const handled = el.handleKeydown(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(handled).toBe(true);
      expect(el.hidden).toBe(true);
      expect(cancelCount).toBe(1);
      expect(evts[0].bubbles).toBe(true);
      expect(evts[0].composed).toBe(true);
    });

    it('handleKeydown returns false when the dropdown is hidden or empty', () => {
      const el = mount();
      // No members yet — hidden.
      expect(el.handleKeydown(new KeyboardEvent('keydown', { key: 'ArrowDown' }))).toBe(
        false,
      );
      expect(el.handleKeydown(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(false);

      el.members = [makeMember({ userId: 'u1' })];
      // Visible; non-handled keys return false.
      expect(el.handleKeydown(new KeyboardEvent('keydown', { key: 'a' }))).toBe(false);
    });

    it('clicking a row syncs the highlight before dispatching `select`', () => {
      const el = mount();
      el.members = [
        makeMember({ userId: 'u1' }),
        makeMember({ userId: 'u2' }),
      ];

      const items = rows(el);
      items[1].click();

      // Highlight followed the click so a subsequent ArrowDown moves to
      // the next row, not back to the start.
      expect(el.highlightedMember?.userId).toBe('u2');
    });

    it('resets the highlight to the first row when the candidate list rebuilds', () => {
      const el = mount();
      el.members = [
        makeMember({ userId: 'u1', name: 'Alice' }),
        makeMember({ userId: 'u2', name: 'Bob' }),
      ];

      el.handleKeydown(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
      expect(el.highlightedMember?.userId).toBe('u2');

      // Re-filter; highlight returns to the first surviving candidate.
      el.query = 'Alice';
      expect(el.highlightedMember?.userId).toBe('u1');
    });
  });
});
