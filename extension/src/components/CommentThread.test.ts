// @vitest-environment jsdom
/**
 * Unit tests for `<fl-comment-thread>` (Requirement 31.3, task 17.5).
 *
 * Covers the three behaviors the task calls out:
 *   1. `comments` property assignment renders an `<ol>` of comment
 *      templates (author, body, time) in chronological order.
 *   2. The textarea + submit button are rendered below the list and the
 *      submit button is disabled while the body is empty / whitespace.
 *   3. On submit, a bubbling+composed `submit` `CustomEvent` is
 *      dispatched with `{ detail: { body, mentions } }`, mentions are
 *      extracted with the same `/@(\w+)/g` regex as the legacy React
 *      implementation, and the textarea is cleared.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Comment as FLComment } from '@pinpoint/shared';
import { FlCommentThread } from './CommentThread';

function makeComment(overrides: Partial<FLComment> = {}): FLComment {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    annotationId: overrides.annotationId ?? 'ann-1',
    authorId: overrides.authorId ?? 'alice',
    body: overrides.body ?? 'hello',
    mentions: overrides.mentions ?? [],
    createdAt: overrides.createdAt ?? new Date('2024-01-01T00:00:00Z').toISOString(),
  };
}

function mount(): FlCommentThread {
  const el = document.createElement('fl-comment-thread') as FlCommentThread;
  document.body.appendChild(el);
  return el;
}

describe('<fl-comment-thread>', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('is registered as a Custom Element', () => {
    expect(customElements.get('fl-comment-thread')).toBe(FlCommentThread);
  });

  it('renders an <ol> with one <li> per comment, including author, body, and time', () => {
    const el = mount();
    const a = makeComment({
      id: 'c1',
      authorId: 'alice',
      body: 'first',
      createdAt: '2024-01-01T00:00:00Z',
    });
    const b = makeComment({
      id: 'c2',
      authorId: 'bob',
      body: 'second',
      createdAt: '2024-01-02T00:00:00Z',
    });
    el.comments = [a, b];

    const ol = el.shadowRoot!.querySelector('ol.fl-comment-thread') as HTMLOListElement;
    expect(ol).toBeTruthy();
    expect(ol.hidden).toBe(false);

    const items = Array.from(ol.querySelectorAll('li.fl-comment'));
    expect(items.length).toBe(2);

    const [first, second] = items;
    expect(first.querySelector('.fl-comment-author')!.textContent).toBe('alice');
    expect(first.querySelector('.fl-comment-body')!.textContent).toBe('first');
    expect(first.querySelector('.fl-comment-time')!.textContent).not.toBe('');
    expect(second.querySelector('.fl-comment-author')!.textContent).toBe('bob');
    expect(second.querySelector('.fl-comment-body')!.textContent).toBe('second');
  });

  it('sorts comments chronologically ascending by createdAt', () => {
    const el = mount();
    const later = makeComment({
      id: 'late',
      body: 'later',
      createdAt: '2024-02-01T00:00:00Z',
    });
    const earlier = makeComment({
      id: 'early',
      body: 'earlier',
      createdAt: '2024-01-01T00:00:00Z',
    });
    el.comments = [later, earlier];

    const items = Array.from(
      el.shadowRoot!.querySelectorAll('li.fl-comment .fl-comment-body')
    );
    expect(items.map((n) => n.textContent)).toEqual(['earlier', 'later']);
  });

  it('hides the <ol> entirely when there are no comments', () => {
    const el = mount();
    el.comments = [];
    const ol = el.shadowRoot!.querySelector('ol.fl-comment-thread') as HTMLOListElement;
    expect(ol.hidden).toBe(true);
    expect(ol.querySelectorAll('li').length).toBe(0);
  });

  it('renders a textarea and a disabled submit button when the body is empty', () => {
    const el = mount();
    const ta = el.shadowRoot!.querySelector('textarea.fl-textarea') as HTMLTextAreaElement;
    const btn = el.shadowRoot!.querySelector('button.fl-btn-primary') as HTMLButtonElement;
    expect(ta).toBeTruthy();
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(true);
  });

  it('enables the submit button as soon as the textarea has non-whitespace content', () => {
    const el = mount();
    const ta = el.shadowRoot!.querySelector('textarea.fl-textarea') as HTMLTextAreaElement;
    const btn = el.shadowRoot!.querySelector('button.fl-btn-primary') as HTMLButtonElement;

    ta.value = '   ';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    expect(btn.disabled).toBe(true);

    ta.value = 'hello';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    expect(btn.disabled).toBe(false);
  });

  it('dispatches a bubbling + composed `submit` CustomEvent with body and mentions on click', () => {
    const el = mount();
    const ta = el.shadowRoot!.querySelector('textarea.fl-textarea') as HTMLTextAreaElement;
    const btn = el.shadowRoot!.querySelector('button.fl-btn-primary') as HTMLButtonElement;

    let received: CustomEvent<{ body: string; mentions: string[] }> | undefined;
    // Listening on `document` confirms the event escapes the Shadow Root
    // (composed: true) and crosses the host boundary (bubbles: true).
    // Cast through `Event` because the lib.dom `submit` map type is
    // `SubmitEvent`; this Custom Element fires a regular CustomEvent.
    document.addEventListener('submit', (e: Event) => {
      received = e as CustomEvent<{ body: string; mentions: string[] }>;
    });

    ta.value = 'looks good @alice and @bob_42';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    btn.click();

    expect(received).toBeDefined();
    expect(received!.bubbles).toBe(true);
    expect(received!.composed).toBe(true);
    expect(received!.detail).toEqual({
      body: 'looks good @alice and @bob_42',
      mentions: ['alice', 'bob_42'],
    });

    // Textarea is cleared and the button is back to disabled after submit.
    expect(ta.value).toBe('');
    expect(btn.disabled).toBe(true);
  });

  it('does not dispatch a `submit` event when the body is whitespace-only', () => {
    const el = mount();
    const ta = el.shadowRoot!.querySelector('textarea.fl-textarea') as HTMLTextAreaElement;
    const btn = el.shadowRoot!.querySelector('button.fl-btn-primary') as HTMLButtonElement;

    let fired = 0;
    el.addEventListener('submit', () => fired++);

    ta.value = '   \n\t  ';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    btn.click();

    expect(fired).toBe(0);
  });

  it('returns an empty mentions array when no @handles appear in the body', () => {
    const el = mount();
    const ta = el.shadowRoot!.querySelector('textarea.fl-textarea') as HTMLTextAreaElement;
    const btn = el.shadowRoot!.querySelector('button.fl-btn-primary') as HTMLButtonElement;

    let detail: { body: string; mentions: string[] } | undefined;
    el.addEventListener('submit', (e: Event) => {
      detail = (e as CustomEvent<{ body: string; mentions: string[] }>).detail;
    });

    ta.value = 'no mentions here';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    btn.click();

    expect(detail).toEqual({ body: 'no mentions here', mentions: [] });
  });

  it('treats null / undefined assignments to `comments` as an empty list', () => {
    const el = mount();
    el.comments = [makeComment()];
    el.comments = null;
    const ol = el.shadowRoot!.querySelector('ol.fl-comment-thread') as HTMLOListElement;
    expect(ol.hidden).toBe(true);
    expect(ol.querySelectorAll('li').length).toBe(0);
  });

  it('reads back the assigned comments via the property getter', () => {
    const el = mount();
    const c = makeComment({ id: 'cX' });
    el.comments = [c];
    expect(el.comments.length).toBe(1);
    expect(el.comments[0].id).toBe('cX');
  });
});
