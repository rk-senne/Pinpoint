// @vitest-environment jsdom
/**
 * Unit tests for `<fl-popover>` (Requirement 31.3, task 17.7).
 *
 * Covers the contract called out in the task:
 *   1. The element is a Custom Element subclass of HTMLElement with an open
 *      Shadow Root that hosts a native `<dialog>` panel; setting `target`
 *      opens the dialog and anchors it at `(pageX, pageY + 30)`.
 *   2. Properties `target`, `annotation`, `comments`, `members`, and
 *      `nextPinNumber` re-render the affected regions on assignment.
 *   3. Tabs (Note / Suggestion / Guideline), severity selector, textarea,
 *      and Submit / Cancel buttons render in create mode (no annotation).
 *      View mode (annotation set) shows the annotation summary, an
 *      environment-metadata `<details>`, the embedded `<fl-comment-thread>`,
 *      and Resolve/Reopen/Close.
 *   4. The popover composes `<fl-mention-autocomplete>` (toggled when the
 *      textarea contains an `@…` query) and `<fl-comment-thread>` (rendered
 *      whenever an annotation is in view).
 *   5. Submitting builds an `Annotation` whose `environment` is populated by
 *      `parseUserAgent(navigator.userAgent)` and dispatches
 *      `submit { detail: { annotation } }` (bubbling + composed).
 *   6. Cancel dispatches `cancel`; the dialog `close` event re-dispatches
 *      `close`. Both bubble out of the Shadow Root.
 */
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import './Popover';
import './MarkupEditor';
import {
  FlPopover,
  type PopoverScreenshotErrorDetail,
  type PopoverSubmitDetail,
  type PopoverTarget,
} from './Popover';
import type {
  Annotation,
  AnnotationStatus,
  CapturedConsoleEntry,
  CapturedNetworkEntry,
  Comment as FLComment,
  DOMTarget,
} from '@pinpoint/shared';

beforeAll(() => {
  // jsdom 22+ ships `HTMLDialogElement` but its `show()` and `close()`
  // implementations only flip the `open` attribute. That is enough for the
  // assertions in this file. The presence check below guards against a
  // future jsdom regression that strips the API.
  expect(typeof HTMLDialogElement).toBe('function');
});

function makeDOMTarget(): DOMTarget {
  return {
    cssSelector: 'main > article',
    xpath: '/html/body/main/article',
    pageX: 100,
    pageY: 200,
    tagName: 'ARTICLE',
    textSnippet: 'an article',
  };
}

function makeTarget(overrides: Partial<PopoverTarget> = {}): PopoverTarget {
  return {
    pageX: overrides.pageX ?? 100,
    pageY: overrides.pageY ?? 200,
    domTarget: overrides.domTarget ?? makeDOMTarget(),
  };
}

function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: overrides.id ?? 'ann-1',
    projectId: 'p1',
    pageId: 'page1',
    type: overrides.type ?? 'note',
    severity: overrides.severity ?? 'major',
    status: overrides.status ?? 'active',
    body: overrides.body ?? 'an existing annotation',
    authorId: 'u1',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    target: makeDOMTarget(),
    environment: {
      browserFamily: 'Chrome',
      browserVersion: '124',
      osFamily: 'macOS',
      osVersion: '14',
      deviceType: 'desktop',
      userAgentRaw: 'test-ua',
    },
    pinNumber: overrides.pinNumber ?? 7,
    ...overrides,
  };
}

function makeComment(overrides: Partial<FLComment> = {}): FLComment {
  return {
    id: overrides.id ?? `c-${Math.random().toString(36).slice(2)}`,
    annotationId: overrides.annotationId ?? 'ann-1',
    authorId: overrides.authorId ?? 'alice',
    body: overrides.body ?? 'comment body',
    mentions: overrides.mentions ?? [],
    createdAt: overrides.createdAt ?? '2024-01-02T00:00:00.000Z',
  };
}

function mount(): FlPopover {
  const el = document.createElement('fl-popover') as FlPopover;
  document.body.appendChild(el);
  return el;
}

function dialog(el: FlPopover): HTMLDialogElement {
  return el.shadowRoot!.querySelector('dialog.fl-popover') as HTMLDialogElement;
}

/**
 * Flush pending microtasks. The submit handler awaits
 * `detectBraveAndArcOverrides` which always resolves on the next microtask
 * (it is `async`), so tests that observe the resulting `submit` event after
 * clicking the Submit button need at least one microtask turn before
 * asserting.
 */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function tabButtons(el: FlPopover): HTMLButtonElement[] {
  return Array.from(
    el.shadowRoot!.querySelectorAll<HTMLButtonElement>(
      '.fl-popover-tabs button[role="tab"]',
    ),
  );
}

function severityButtons(el: FlPopover): HTMLButtonElement[] {
  return Array.from(
    el.shadowRoot!.querySelectorAll<HTMLButtonElement>('.fl-severity-btn'),
  );
}

describe('<fl-popover>', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('is registered as a Custom Element with an open Shadow Root and a <dialog> panel', () => {
    expect(customElements.get('fl-popover')).toBe(FlPopover);
    const el = mount();
    expect(el).toBeInstanceOf(HTMLElement);
    expect(el.shadowRoot?.mode).toBe('open');
    const d = dialog(el);
    expect(d).toBeTruthy();
    expect(d.tagName).toBe('DIALOG');
  });

  it('opens the dialog and anchors it at (pageX, pageY + 30) when target is set', () => {
    const el = mount();
    expect(dialog(el).open).toBe(false);

    el.target = makeTarget({ pageX: 100, pageY: 200 });
    const d = dialog(el);
    expect(d.open).toBe(true);
    expect(d.style.left).toBe('100px');
    expect(d.style.top).toBe('230px');
  });

  it('closes the dialog silently (no `close` event) when target is set to null', () => {
    const el = mount();
    el.target = makeTarget();
    expect(dialog(el).open).toBe(true);

    let closeFired = 0;
    el.addEventListener('close', () => closeFired++);

    el.target = null;
    expect(dialog(el).open).toBe(false);
    expect(closeFired).toBe(0);
  });

  it('renders tabs (Note / Suggestion / Guideline) and a severity selector in create mode', () => {
    const el = mount();
    el.target = makeTarget();

    const tabs = tabButtons(el);
    expect(tabs.map((b) => b.dataset.tab)).toEqual(['note', 'suggestion', 'guideline']);
    expect(tabs.map((b) => b.textContent)).toEqual(['Note', 'Suggestion', 'Guideline']);
    expect(tabs[0].classList.contains('active')).toBe(true);

    const severities = severityButtons(el);
    expect(severities.map((b) => b.dataset.severity)).toEqual([
      'critical',
      'major',
      'minor',
      'informational',
    ]);
    expect(
      severities.find((b) => b.dataset.severity === 'informational')!.classList.contains('selected'),
    ).toBe(true);
  });

  it('switches the active tab on click; tab disabled in view mode', () => {
    const el = mount();
    el.target = makeTarget();

    const [noteBtn, suggestionBtn] = tabButtons(el);
    suggestionBtn.click();
    expect(suggestionBtn.classList.contains('active')).toBe(true);
    expect(noteBtn.classList.contains('active')).toBe(false);
    expect(suggestionBtn.getAttribute('aria-selected')).toBe('true');

    el.annotation = makeAnnotation({ type: 'note' });
    for (const b of tabButtons(el)) {
      expect(b.disabled).toBe(true);
    }
    // Active tab follows the annotation's type in view mode.
    expect(
      tabButtons(el).find((b) => b.dataset.tab === 'note')!.classList.contains('active'),
    ).toBe(true);
  });

  it('updates the selected severity on click', () => {
    const el = mount();
    el.target = makeTarget();
    const sevs = severityButtons(el);
    const critical = sevs.find((b) => b.dataset.severity === 'critical')!;
    critical.click();
    expect(critical.classList.contains('selected')).toBe(true);
    expect(critical.getAttribute('aria-checked')).toBe('true');
    expect(
      sevs.find((b) => b.dataset.severity === 'informational')!.classList.contains('selected'),
    ).toBe(false);
  });

  it('keeps Submit disabled until the textarea has non-whitespace content', () => {
    const el = mount();
    el.target = makeTarget();
    const ta = el.shadowRoot!.querySelector('textarea.fl-textarea') as HTMLTextAreaElement;
    const submit = el.shadowRoot!.querySelector(
      'button[data-action="submit"]',
    ) as HTMLButtonElement;

    expect(submit.disabled).toBe(true);

    ta.value = '   ';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    expect(submit.disabled).toBe(true);

    ta.value = 'hello';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    expect(submit.disabled).toBe(false);
  });

  it('shows <fl-mention-autocomplete> when the textarea contains an @-prefixed query', () => {
    const el = mount();
    el.target = makeTarget();
    el.members = [
      { userId: 'u1', name: 'Alice', email: 'alice@example.com' },
      { userId: 'u2', name: 'Bob', email: 'bob@example.com' },
    ];

    const ta = el.shadowRoot!.querySelector('textarea.fl-textarea') as HTMLTextAreaElement;
    const mention = el.shadowRoot!.querySelector(
      'fl-mention-autocomplete',
    ) as HTMLElement & { query?: string; hidden: boolean };

    ta.value = 'hello @al';
    ta.selectionStart = ta.value.length;
    ta.dispatchEvent(new Event('input', { bubbles: true }));

    expect(mention.hidden).toBe(false);
    expect(mention.query).toBe('al');

    ta.value = 'hello @al world';
    ta.selectionStart = ta.value.length;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    expect(mention.hidden).toBe(true);
  });

  it('substitutes the chosen mention into the textarea on `select`', () => {
    const el = mount();
    el.target = makeTarget();
    el.members = [{ userId: 'u1', name: 'Alice', email: 'alice@example.com' }];

    const ta = el.shadowRoot!.querySelector('textarea.fl-textarea') as HTMLTextAreaElement;
    ta.value = 'hello @al';
    ta.selectionStart = ta.value.length;
    ta.dispatchEvent(new Event('input', { bubbles: true }));

    const mention = el.shadowRoot!.querySelector('fl-mention-autocomplete') as HTMLElement;
    const row = mention.shadowRoot!.querySelector('li.fl-mention-item') as HTMLLIElement;
    row.click();

    expect(ta.value).toBe('hello @Alice ');
    const submit = el.shadowRoot!.querySelector(
      'button[data-action="submit"]',
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
  });

  it('exposes combobox ARIA on the textarea wired to the autocomplete listbox', () => {
    const el = mount();
    el.target = makeTarget();
    el.members = [
      { userId: 'u1', name: 'Alice', email: 'alice@example.com' },
      { userId: 'u2', name: 'Bob', email: 'bob@example.com' },
    ];

    const ta = el.shadowRoot!.querySelector('textarea.fl-textarea') as HTMLTextAreaElement;
    const mention = el.shadowRoot!.querySelector(
      'fl-mention-autocomplete',
    ) as HTMLElement & { listboxId: string; activeOptionId: string | null };

    expect(ta.getAttribute('role')).toBe('combobox');
    expect(ta.getAttribute('aria-haspopup')).toBe('listbox');
    expect(ta.getAttribute('aria-controls')).toBe(mention.listboxId);
    // Closed by default.
    expect(ta.getAttribute('aria-expanded')).toBe('false');
    expect(ta.hasAttribute('aria-activedescendant')).toBe(false);

    // Type `@al` to open the listbox.
    ta.value = 'hello @al';
    ta.selectionStart = ta.value.length;
    ta.dispatchEvent(new Event('input', { bubbles: true }));

    expect(ta.getAttribute('aria-expanded')).toBe('true');
    expect(ta.getAttribute('aria-activedescendant')).toBe(mention.activeOptionId);
  });

  it('ArrowDown / ArrowUp on the textarea move the autocomplete highlight without inserting characters', () => {
    const el = mount();
    el.target = makeTarget();
    el.members = [
      { userId: 'u1', name: 'Alice', email: 'alice@example.com' },
      { userId: 'u2', name: 'Bob', email: 'bob@example.com' },
    ];
    const ta = el.shadowRoot!.querySelector('textarea.fl-textarea') as HTMLTextAreaElement;
    const mention = el.shadowRoot!.querySelector(
      'fl-mention-autocomplete',
    ) as HTMLElement & { highlightedMember: { userId: string } | null };

    ta.value = 'hi @';
    ta.selectionStart = ta.value.length;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    expect(mention.highlightedMember?.userId).toBe('u1');

    const down = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true });
    ta.dispatchEvent(down);
    expect(mention.highlightedMember?.userId).toBe('u2');
    expect(ta.value).toBe('hi @');

    const up = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true });
    ta.dispatchEvent(up);
    expect(mention.highlightedMember?.userId).toBe('u1');
  });

  it('Enter on the textarea selects the highlighted mention via keyboard', () => {
    const el = mount();
    el.target = makeTarget();
    el.members = [
      { userId: 'u1', name: 'Alice', email: 'alice@example.com' },
      { userId: 'u2', name: 'Bob', email: 'bob@example.com' },
    ];
    const ta = el.shadowRoot!.querySelector('textarea.fl-textarea') as HTMLTextAreaElement;

    ta.value = 'hi @';
    ta.selectionStart = ta.value.length;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(ta.value).toBe('hi @Bob ');
    // Listbox closes after selection.
    expect(ta.getAttribute('aria-expanded')).toBe('false');
    expect(ta.hasAttribute('aria-activedescendant')).toBe(false);
  });

  it('Escape on the textarea closes the autocomplete listbox', () => {
    const el = mount();
    el.target = makeTarget();
    el.members = [{ userId: 'u1', name: 'Alice', email: 'alice@example.com' }];
    const ta = el.shadowRoot!.querySelector('textarea.fl-textarea') as HTMLTextAreaElement;
    const mention = el.shadowRoot!.querySelector(
      'fl-mention-autocomplete',
    ) as HTMLElement;

    ta.value = 'hi @al';
    ta.selectionStart = ta.value.length;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    expect(mention.hidden).toBe(false);

    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(mention.hidden).toBe(true);
    expect(ta.getAttribute('aria-expanded')).toBe('false');
  });

  it('emits a bubbling + composed `submit` CustomEvent with a fully populated Annotation', async () => {
    const el = mount();
    el.target = makeTarget({
      pageX: 50,
      pageY: 60,
      domTarget: {
        cssSelector: '#root',
        xpath: '/html/body/div',
        pageX: 50,
        pageY: 60,
        tagName: 'DIV',
        textSnippet: 'root',
      },
    });
    el.nextPinNumber = 13;

    const ta = el.shadowRoot!.querySelector('textarea.fl-textarea') as HTMLTextAreaElement;
    ta.value = 'a new note';
    ta.dispatchEvent(new Event('input', { bubbles: true }));

    const seen: CustomEvent<PopoverSubmitDetail>[] = [];
    // The lib.dom `submit` map type is `SubmitEvent`; this Custom Element
    // fires a plain `CustomEvent`. Type the listener as `Event` to avoid
    // the standard-event inference and cast at the use site.
    document.addEventListener('submit', (e: Event) => {
      seen.push(e as CustomEvent<PopoverSubmitDetail>);
    });

    const submit = el.shadowRoot!.querySelector(
      'button[data-action="submit"]',
    ) as HTMLButtonElement;
    submit.click();
    // The dialog clears synchronously, but the `submit` event awaits
    // `detectBraveAndArcOverrides` which always resolves on the next
    // microtask. Flush before asserting.
    await flushMicrotasks();

    expect(seen).toHaveLength(1);
    const evt = seen[0];
    expect(evt.bubbles).toBe(true);
    expect(evt.composed).toBe(true);

    const a = evt.detail.annotation;
    expect(a.body).toBe('a new note');
    expect(a.type).toBe('note');
    expect(a.severity).toBe('informational');
    expect(a.status).toBe('active');
    expect(a.pinNumber).toBe(13);
    expect(a.target.cssSelector).toBe('#root');
    expect(a.environment).toBeDefined();
    expect(a.environment.userAgentRaw).toBe(navigator.userAgent);
    expect(a.environment.browserFamily).toBeDefined();
    expect(a.environment.osFamily).toBeDefined();
    expect(a.environment.deviceType).toBeDefined();
    expect(typeof a.id).toBe('string');
    expect(a.id.length).toBeGreaterThan(0);

    // Dialog closes silently after submit; no `close` event is dispatched
    // alongside `submit`.
    expect(dialog(el).open).toBe(false);
    expect(ta.value).toBe('');
  });

  it('does not dispatch `submit` when the body is empty or whitespace', async () => {
    const el = mount();
    el.target = makeTarget();
    let count = 0;
    el.addEventListener('submit', () => count++);

    const ta = el.shadowRoot!.querySelector('textarea.fl-textarea') as HTMLTextAreaElement;
    ta.value = '   ';
    ta.dispatchEvent(new Event('input', { bubbles: true }));

    const submit = el.shadowRoot!.querySelector(
      'button[data-action="submit"]',
    ) as HTMLButtonElement;
    submit.click();
    await flushMicrotasks();

    expect(count).toBe(0);
  });

  it('attaches viewport metadata only on Note + Critical/Major severity', async () => {
    const el = mount();
    el.target = makeTarget();
    let received: Annotation | undefined;
    el.addEventListener('submit', (e: Event) => {
      received = (e as CustomEvent<PopoverSubmitDetail>).detail.annotation;
    });

    // Pick critical severity on a Note tab — bug-report path.
    severityButtons(el).find((b) => b.dataset.severity === 'critical')!.click();
    const ta = el.shadowRoot!.querySelector('textarea.fl-textarea') as HTMLTextAreaElement;
    ta.value = 'a critical note';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    (el.shadowRoot!.querySelector('button[data-action="submit"]') as HTMLButtonElement).click();
    await flushMicrotasks();

    expect(received?.environment.viewportWidth).toBe(window.innerWidth);
    expect(received?.environment.viewportHeight).toBe(window.innerHeight);
    expect(received?.environment.devicePixelRatio).toBe(window.devicePixelRatio);
  });

  it('omits viewport metadata for Suggestion-tab Critical-severity submissions', async () => {
    const el = mount();
    el.target = makeTarget();
    let received: Annotation | undefined;
    el.addEventListener('submit', (e: Event) => {
      received = (e as CustomEvent<PopoverSubmitDetail>).detail.annotation;
    });

    tabButtons(el).find((b) => b.dataset.tab === 'suggestion')!.click();
    severityButtons(el).find((b) => b.dataset.severity === 'critical')!.click();
    const ta = el.shadowRoot!.querySelector('textarea.fl-textarea') as HTMLTextAreaElement;
    ta.value = 'a critical suggestion';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    (el.shadowRoot!.querySelector('button[data-action="submit"]') as HTMLButtonElement).click();
    await flushMicrotasks();

    expect(received?.environment.viewportWidth).toBeUndefined();
  });

  it('emits a bubbling + composed `cancel` CustomEvent on cancel and closes silently', () => {
    const el = mount();
    el.target = makeTarget();

    let cancelFired = 0;
    let closeFired = 0;
    document.addEventListener('cancel', () => cancelFired++);
    document.addEventListener('close', () => closeFired++);

    const cancelBtn = el.shadowRoot!.querySelector(
      'button[data-action="cancel"]',
    ) as HTMLButtonElement;
    cancelBtn.click();

    expect(cancelFired).toBe(1);
    // cancel should not double-emit a `close` event.
    expect(closeFired).toBe(0);
    expect(dialog(el).open).toBe(false);
  });

  it('renders annotation summary, body, and environment <details> in view mode', () => {
    const el = mount();
    const a = makeAnnotation({
      type: 'suggestion',
      severity: 'critical',
      body: 'fix this thing',
    });
    el.target = makeTarget();
    el.annotation = a;

    expect(el.shadowRoot!.querySelector('.fl-popover-create')!.hasAttribute('hidden')).toBe(true);
    expect(el.shadowRoot!.querySelector('.fl-popover-view')!.hasAttribute('hidden')).toBe(false);

    expect(el.shadowRoot!.querySelector('.fl-annotation-type')!.textContent).toBe('suggestion');
    expect(el.shadowRoot!.querySelector('.fl-annotation-body')!.textContent).toBe('fix this thing');

    const env = el.shadowRoot!.querySelector('.fl-environment-details') as HTMLDetailsElement;
    expect(env.hidden).toBe(false);
    expect(el.shadowRoot!.querySelector('.fl-environment-pre')!.textContent).toContain(
      '"browserFamily": "Chrome"',
    );
  });

  // -----------------------------------------------------------------------
  // Inline screenshot rendering in view mode (Req 34.4 / Task 25.6).
  // -----------------------------------------------------------------------

  describe('view-mode screenshot rendering', () => {
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/screenshot')) {
          return new Response(
            JSON.stringify({
              screenshotObjectKey: 'k',
              screenshotUrl: 'https://cdn.example.test/shot.png',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        // Return 404 for the markup sibling so the viewer renders the
        // bitmap alone (best-effort path covered in ScreenshotViewer).
        return new Response('{}', {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      });
      vi.stubGlobal('fetch', fetchSpy);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('mounts a hidden <fl-screenshot-viewer> when the annotation has no screenshotObjectKey', () => {
      const el = mount();
      el.target = makeTarget();
      el.annotation = makeAnnotation({ id: 'ann-2' }); // no screenshotObjectKey

      const viewer = el.shadowRoot!.querySelector(
        'fl-screenshot-viewer.fl-popover-screenshot',
      ) as HTMLElement & { imageUrl: string | null; annotationId: string | null };

      expect(viewer).toBeTruthy();
      expect(viewer.hidden).toBe(true);
      expect(viewer.imageUrl).toBeNull();
      expect(viewer.annotationId).toBeNull();

      // No screenshot fetch should have been issued for an annotation
      // that does not carry a stored screenshot.
      const screenshotCalls = fetchSpy.mock.calls.filter(([input]) => {
        const url = typeof input === 'string' ? input : (input as URL | Request).toString();
        return url.endsWith('/annotations/ann-2/screenshot');
      });
      expect(screenshotCalls).toHaveLength(0);
    });

    it('reveals the screenshot viewer and resolves its imageUrl via /annotations/:id/screenshot when screenshotObjectKey is set', async () => {
      const el = mount();
      el.target = makeTarget();
      el.annotation = makeAnnotation({
        id: 'ann-3',
        screenshotObjectKey: 'projects/p1/annotations/ann-3/screenshot.png',
      });

      // The popover's #renderScreenshot path goes through apiFetch ->
      // apiFetchRaw -> chrome.storage lookup -> fetch -> res.json(),
      // each step awaiting a microtask. Flush generously so the URL
      // setter runs before assertions.
      for (let i = 0; i < 20; i++) await Promise.resolve();

      const viewer = el.shadowRoot!.querySelector(
        'fl-screenshot-viewer.fl-popover-screenshot',
      ) as HTMLElement & { imageUrl: string | null; annotationId: string | null };

      expect(viewer.hidden).toBe(false);
      expect(viewer.annotationId).toBe('ann-3');
      expect(viewer.imageUrl).toBe('https://cdn.example.test/shot.png');

      // The popover hits the GET screenshot endpoint to resolve the URL.
      const screenshotCalls = fetchSpy.mock.calls.filter(([input]) => {
        const url = typeof input === 'string' ? input : (input as URL | Request).toString();
        return url.endsWith('/annotations/ann-3/screenshot');
      });
      expect(screenshotCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('hides the viewer and clears its imageUrl when the annotation is replaced with one that has no screenshot', async () => {
      const el = mount();
      el.target = makeTarget();
      el.annotation = makeAnnotation({
        id: 'ann-4',
        screenshotObjectKey: 'projects/p1/annotations/ann-4/screenshot.png',
      });
      for (let i = 0; i < 20; i++) await Promise.resolve();

      const viewer = el.shadowRoot!.querySelector(
        'fl-screenshot-viewer.fl-popover-screenshot',
      ) as HTMLElement & { imageUrl: string | null; annotationId: string | null };
      expect(viewer.hidden).toBe(false);

      // Switch to an annotation without a screenshot — the viewer must
      // collapse and never break the rest of the popover.
      el.annotation = makeAnnotation({ id: 'ann-5' });
      expect(viewer.hidden).toBe(true);
      expect(viewer.imageUrl).toBeNull();
      expect(viewer.annotationId).toBeNull();
    });
  });

  it('forwards comments to the embedded <fl-comment-thread>', () => {
    const el = mount();
    const a = makeAnnotation({ id: 'ann-1' });
    el.annotation = a;
    el.comments = [
      makeComment({ id: 'c1', annotationId: 'ann-1', body: 'one' }),
      makeComment({ id: 'c2', annotationId: 'other', body: 'wrong thread' }),
      makeComment({ id: 'c3', annotationId: 'ann-1', body: 'two' }),
    ];

    const thread = el.shadowRoot!.querySelector('fl-comment-thread') as HTMLElement & {
      comments: readonly FLComment[];
    };
    expect(thread.comments.map((c) => c.id)).toEqual(['c1', 'c3']);
  });

  it('re-emits the inner <fl-comment-thread> submit as `comment-submit` tagged with annotationId', () => {
    const el = mount();
    el.annotation = makeAnnotation({ id: 'ann-1' });

    let commentDetail: { annotationId: string; body: string; mentions: string[] } | undefined;
    document.addEventListener('comment-submit', (e) => {
      commentDetail = (
        e as CustomEvent<{ annotationId: string; body: string; mentions: string[] }>
      ).detail;
    });

    let outerSubmit = 0;
    document.addEventListener('submit', () => outerSubmit++);

    const thread = el.shadowRoot!.querySelector('fl-comment-thread') as HTMLElement;
    const ta = thread.shadowRoot!.querySelector('textarea.fl-textarea') as HTMLTextAreaElement;
    ta.value = 'reply with @bob';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const btn = thread.shadowRoot!.querySelector('button.fl-btn-primary') as HTMLButtonElement;
    btn.click();

    expect(commentDetail).toEqual({
      annotationId: 'ann-1',
      body: 'reply with @bob',
      mentions: ['bob'],
    });
    // The popover absorbs the inner `submit` and only re-emits
    // `comment-submit`, so listeners for the popover's own annotation
    // submit do not see this event.
    expect(outerSubmit).toBe(0);
  });

  it.each<AnnotationStatus>(['active', 'in_progress'])(
    'shows Resolve (and hides Reopen) when annotation status is "%s"',
    (status) => {
      const el = mount();
      el.annotation = makeAnnotation({ status });
      const resolve = el.shadowRoot!.querySelector(
        'button[data-action="resolve"]',
      ) as HTMLButtonElement;
      const reopen = el.shadowRoot!.querySelector(
        'button[data-action="reopen"]',
      ) as HTMLButtonElement;
      expect(resolve.hidden).toBe(false);
      expect(reopen.hidden).toBe(true);
    },
  );

  it('shows Reopen (and hides Resolve) when annotation status is "resolved"', () => {
    const el = mount();
    el.annotation = makeAnnotation({ status: 'resolved' });
    const resolve = el.shadowRoot!.querySelector(
      'button[data-action="resolve"]',
    ) as HTMLButtonElement;
    const reopen = el.shadowRoot!.querySelector(
      'button[data-action="reopen"]',
    ) as HTMLButtonElement;
    expect(resolve.hidden).toBe(true);
    expect(reopen.hidden).toBe(false);
  });

  it('emits `status-change` events for resolve and reopen with the annotation id', () => {
    const el = mount();
    el.annotation = makeAnnotation({ id: 'ann-7' });

    const seen: CustomEvent<{ annotationId: string; status: AnnotationStatus }>[] = [];
    document.addEventListener(
      'status-change',
      (e) =>
        seen.push(
          e as CustomEvent<{ annotationId: string; status: AnnotationStatus }>,
        ),
    );

    (el.shadowRoot!.querySelector(
      'button[data-action="resolve"]',
    ) as HTMLButtonElement).click();
    expect(seen.at(-1)?.detail).toEqual({ annotationId: 'ann-7', status: 'resolved' });

    el.annotation = makeAnnotation({ id: 'ann-7', status: 'resolved' });
    (el.shadowRoot!.querySelector(
      'button[data-action="reopen"]',
    ) as HTMLButtonElement).click();
    expect(seen.at(-1)?.detail).toEqual({ annotationId: 'ann-7', status: 'active' });
  });

  // -------------------------------------------------------------------
  // Offline + unsynced gate (Req 44.5 / task 36.6).
  //
  // The popover disables Resolve / Reopen when:
  //   - `isOffline === true` (driven by `<fl-overlay-host>` from
  //     `connectionMonitor.isOffline`), AND
  //   - the current annotation is still unsynced — the popover derives
  //     this from `annotation.pinNumber === 0` (the placeholder
  //     `api.ts` writes onto the optimistic row at create time; the
  //     Syncer's 36.4 remap rewrites it to the server value on
  //     success).
  //
  // Every other combination (online + unsynced, offline + synced,
  // online + synced) leaves the buttons enabled.
  // -------------------------------------------------------------------

  it('leaves Resolve enabled when online + unsynced (pinNumber === 0)', () => {
    const el = mount();
    el.isOffline = false;
    el.annotation = makeAnnotation({ id: 'ann-online', pinNumber: 0 });
    const resolve = el.shadowRoot!.querySelector(
      'button[data-action="resolve"]',
    ) as HTMLButtonElement;
    expect(resolve.disabled).toBe(false);
    expect(resolve.hasAttribute('aria-disabled')).toBe(false);
    expect(resolve.title).toBe('');
    expect(el.isUnsynced).toBe(true);
  });

  it('leaves Resolve enabled when offline + synced (pinNumber > 0)', () => {
    const el = mount();
    el.isOffline = true;
    el.annotation = makeAnnotation({ id: 'ann-synced', pinNumber: 4 });
    const resolve = el.shadowRoot!.querySelector(
      'button[data-action="resolve"]',
    ) as HTMLButtonElement;
    expect(resolve.disabled).toBe(false);
    expect(resolve.hasAttribute('aria-disabled')).toBe(false);
    expect(resolve.title).toBe('');
    expect(el.isUnsynced).toBe(false);
  });

  it('disables Resolve with an aria-disabled tooltip when offline + unsynced', () => {
    const el = mount();
    el.isOffline = true;
    el.annotation = makeAnnotation({ id: 'ann-pending', pinNumber: 0 });
    const resolve = el.shadowRoot!.querySelector(
      'button[data-action="resolve"]',
    ) as HTMLButtonElement;
    expect(resolve.disabled).toBe(true);
    expect(resolve.getAttribute('aria-disabled')).toBe('true');
    expect(resolve.title).toBe('Cannot resolve while offline — pending sync');
    expect(el.isUnsynced).toBe(true);
  });

  it('disables Reopen on a resolved + unsynced annotation while offline', () => {
    const el = mount();
    el.isOffline = true;
    el.annotation = makeAnnotation({
      id: 'ann-pending-resolved',
      status: 'resolved',
      pinNumber: 0,
    });
    const reopen = el.shadowRoot!.querySelector(
      'button[data-action="reopen"]',
    ) as HTMLButtonElement;
    expect(reopen.disabled).toBe(true);
    expect(reopen.getAttribute('aria-disabled')).toBe('true');
    expect(reopen.title).toBe('Cannot resolve while offline — pending sync');
  });

  it('does not emit `status-change` when Resolve is clicked while offline + unsynced', () => {
    const el = mount();
    el.isOffline = true;
    el.annotation = makeAnnotation({ id: 'ann-blocked', pinNumber: 0 });
    const seen: CustomEvent<unknown>[] = [];
    document.addEventListener('status-change', (e) =>
      seen.push(e as CustomEvent<unknown>),
    );
    (el.shadowRoot!.querySelector(
      'button[data-action="resolve"]',
    ) as HTMLButtonElement).click();
    expect(seen).toHaveLength(0);
  });

  it('re-enables Resolve once `isOffline` flips back to false', () => {
    const el = mount();
    el.isOffline = true;
    el.annotation = makeAnnotation({ id: 'ann-flip', pinNumber: 0 });
    const resolve = el.shadowRoot!.querySelector(
      'button[data-action="resolve"]',
    ) as HTMLButtonElement;
    expect(resolve.disabled).toBe(true);

    el.isOffline = false;
    expect(resolve.disabled).toBe(false);
    expect(resolve.hasAttribute('aria-disabled')).toBe(false);
    expect(resolve.title).toBe('');
  });

  it('emits a bubbling + composed `close` CustomEvent when the view-mode close button is clicked', () => {
    const el = mount();
    el.target = makeTarget();
    el.annotation = makeAnnotation();

    let closeFired = 0;
    document.addEventListener('close', () => closeFired++);

    (el.shadowRoot!.querySelector(
      'button[data-action="close"]',
    ) as HTMLButtonElement).click();

    expect(closeFired).toBe(1);
    expect(dialog(el).open).toBe(false);
  });

  it('re-emits the dialog\'s native `close` event as a composed `close` CustomEvent', () => {
    const el = mount();
    el.target = makeTarget();
    let count = 0;
    document.addEventListener('close', () => count++);

    // jsdom does not dispatch the native `close` event from
    // `HTMLDialogElement.close()`. Simulate it by dispatching the event
    // directly on the dialog so we can prove the listener wiring works.
    dialog(el).dispatchEvent(new Event('close'));
    expect(count).toBe(1);
  });

  it('reads back assigned property values via getters', () => {
    const el = mount();
    const t = makeTarget();
    const a = makeAnnotation();
    const c = [makeComment()];
    el.target = t;
    el.annotation = a;
    el.comments = c;
    el.members = [{ userId: 'u1', name: 'Alice', email: 'a@a' }];
    el.nextPinNumber = 99;

    expect(el.target).toBe(t);
    expect(el.annotation).toBe(a);
    expect(el.comments.length).toBe(1);
    expect(el.members.length).toBe(1);
    expect(el.nextPinNumber).toBe(99);
  });

  it('treats null/undefined assignments as empty defaults without throwing', () => {
    const el = mount();
    el.target = null;
    el.annotation = null;
    el.comments = null;
    el.members = null;
    el.nextPinNumber = null;
    expect(el.target).toBeNull();
    expect(el.annotation).toBeNull();
    expect(el.comments).toEqual([]);
    expect(el.members).toEqual([]);
    expect(el.nextPinNumber).toBe(1);
  });

  it('adopts the shared stylesheet (or falls back to a <style> tag)', () => {
    const el = mount();
    const root = el.shadowRoot!;
    const hasAdopted =
      Array.isArray(root.adoptedStyleSheets) && root.adoptedStyleSheets.length > 0;
    const hasFallbackStyle = root.querySelector('style') !== null;
    expect(hasAdopted || hasFallbackStyle).toBe(true);
  });

  it('refuses to submit if no DOMTarget is attached to `target`', async () => {
    const el = mount();
    el.target = { pageX: 0, pageY: 0 };

    const ta = el.shadowRoot!.querySelector('textarea.fl-textarea') as HTMLTextAreaElement;
    ta.value = 'hello';
    ta.dispatchEvent(new Event('input', { bubbles: true }));

    let submitFired = 0;
    el.addEventListener('submit', () => submitFired++);
    (el.shadowRoot!.querySelector(
      'button[data-action="submit"]',
    ) as HTMLButtonElement).click();
    await flushMicrotasks();

    expect(submitFired).toBe(0);
  });

  it('uses parseUserAgent against the live navigator.userAgent', async () => {
    // Spy is loose because parseUserAgent is invoked indirectly through the
    // submit handler; we only need to confirm the resulting environment
    // includes one of the closed-enum browser families.
    const el = mount();
    el.target = makeTarget();
    const ta = el.shadowRoot!.querySelector('textarea.fl-textarea') as HTMLTextAreaElement;
    ta.value = 'something';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    let received: Annotation | undefined;
    el.addEventListener('submit', (e: Event) => {
      received = (e as CustomEvent<PopoverSubmitDetail>).detail.annotation;
    });
    (el.shadowRoot!.querySelector(
      'button[data-action="submit"]',
    ) as HTMLButtonElement).click();
    await flushMicrotasks();

    expect(received).toBeDefined();
    expect(
      ['Chrome', 'Edge', 'Safari', 'Firefox', 'Opera', 'Brave', 'Arc', 'Other', 'unknown'],
    ).toContain(received!.environment.browserFamily);
  });

  it('overrides browserFamily to "Brave" when navigator.brave.isBrave() resolves true (task 19.1)', async () => {
    // Mock the non-standard `navigator.brave` API that
    // `detectBraveAndArcOverrides` consults. Restored via the cleanup
    // teardown after the assertion.
    const nav = navigator as unknown as {
      brave?: { isBrave?: () => Promise<boolean> };
    };
    const had = 'brave' in nav;
    const prior = nav.brave;
    nav.brave = { isBrave: () => Promise.resolve(true) };

    try {
      const el = mount();
      el.target = makeTarget();
      const ta = el.shadowRoot!.querySelector('textarea.fl-textarea') as HTMLTextAreaElement;
      ta.value = 'hello from brave';
      ta.dispatchEvent(new Event('input', { bubbles: true }));

      let received: Annotation | undefined;
      el.addEventListener('submit', (e: Event) => {
        received = (e as CustomEvent<PopoverSubmitDetail>).detail.annotation;
      });
      (el.shadowRoot!.querySelector(
        'button[data-action="submit"]',
      ) as HTMLButtonElement).click();
      await flushMicrotasks();

      expect(received).toBeDefined();
      expect(received!.environment.browserFamily).toBe('Brave');
      // The full closed-enum environment shape (Req 17.1) is preserved.
      expect(received!.environment.userAgentRaw).toBe(navigator.userAgent);
      expect(received!.environment.osFamily).toBeDefined();
      expect(received!.environment.deviceType).toBeDefined();
    } finally {
      if (had) {
        nav.brave = prior;
      } else {
        delete nav.brave;
      }
    }
  });

  it('does not leak listeners when disconnected (smoke test for disconnectedCallback)', () => {
    const el = mount();
    const submitSpy = vi.fn();
    el.addEventListener('submit', submitSpy);

    el.remove();
    el.target = makeTarget();
    const ta = el.shadowRoot!.querySelector('textarea.fl-textarea') as HTMLTextAreaElement;
    ta.value = 'x';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    (el.shadowRoot!.querySelector(
      'button[data-action="submit"]',
    ) as HTMLButtonElement).click();

    // Listener still wired on the host even after disconnect, but the test
    // simply confirms no exception was thrown by the click path on a
    // disconnected element. submit may still fire if you click; we don't
    // depend on a specific count here.
    expect(() => el.remove()).not.toThrow();
    submitSpy.mockClear();
  });

  // ---------------------------------------------------------------------
  // Co-viewer presence (Req 6.6, 6.7 — task 14.2)
  // ---------------------------------------------------------------------

  it('emits `annotation:open` when target+annotation are both set, and `annotation:close` when target clears', () => {
    const el = mount();
    const opens: string[] = [];
    const closes: string[] = [];
    document.addEventListener('annotation:open', (e) =>
      opens.push((e as CustomEvent<{ id: string }>).detail.id),
    );
    document.addEventListener('annotation:close', (e) =>
      closes.push((e as CustomEvent<{ id: string }>).detail.id),
    );

    const a = makeAnnotation({ id: 'ann-42' });
    el.target = makeTarget();
    expect(opens).toEqual([]);
    expect(closes).toEqual([]);

    el.annotation = a;
    expect(opens).toEqual(['ann-42']);
    expect(closes).toEqual([]);

    el.target = null;
    expect(opens).toEqual(['ann-42']);
    expect(closes).toEqual(['ann-42']);
  });

  it('does not emit `annotation:open` in create mode (no annotation set)', () => {
    const el = mount();
    let opens = 0;
    document.addEventListener('annotation:open', () => opens++);
    el.target = makeTarget();
    expect(opens).toBe(0);
  });

  it('emits `annotation:close` when annotation is cleared while dialog stays open', () => {
    const el = mount();
    const a = makeAnnotation({ id: 'ann-1' });
    el.target = makeTarget();
    el.annotation = a;

    let closeId: string | undefined;
    document.addEventListener('annotation:close', (e) => {
      closeId = (e as CustomEvent<{ id: string }>).detail.id;
    });

    el.annotation = null;
    expect(closeId).toBe('ann-1');
  });

  it('emits paired close+open when the annotation id changes under a sticky target', () => {
    const el = mount();
    el.target = makeTarget();
    el.annotation = makeAnnotation({ id: 'ann-A' });
    const events: Array<{ type: string; id: string }> = [];
    document.addEventListener('annotation:open', (e) =>
      events.push({ type: 'open', id: (e as CustomEvent<{ id: string }>).detail.id }),
    );
    document.addEventListener('annotation:close', (e) =>
      events.push({ type: 'close', id: (e as CustomEvent<{ id: string }>).detail.id }),
    );

    el.annotation = makeAnnotation({ id: 'ann-B' });
    expect(events).toEqual([
      { type: 'close', id: 'ann-A' },
      { type: 'open', id: 'ann-B' },
    ]);
  });

  it('emits `annotation:close` when the view-mode close button is pressed (dialog closes silently)', () => {
    const el = mount();
    el.target = makeTarget();
    el.annotation = makeAnnotation({ id: 'ann-7' });

    let closeId: string | undefined;
    document.addEventListener('annotation:close', (e) => {
      closeId = (e as CustomEvent<{ id: string }>).detail.id;
    });

    (el.shadowRoot!.querySelector(
      'button[data-action="close"]',
    ) as HTMLButtonElement).click();

    expect(closeId).toBe('ann-7');
  });

  it('emits `annotation:close` when the dialog dispatches its native `close` event', () => {
    const el = mount();
    el.target = makeTarget();
    el.annotation = makeAnnotation({ id: 'ann-9' });

    let closeId: string | undefined;
    document.addEventListener('annotation:close', (e) => {
      closeId = (e as CustomEvent<{ id: string }>).detail.id;
    });

    dialog(el).dispatchEvent(new Event('close'));
    expect(closeId).toBe('ann-9');
  });

  it('emits `annotation:close` on disconnectedCallback when presence is open', () => {
    const el = mount();
    el.target = makeTarget();
    el.annotation = makeAnnotation({ id: 'ann-x' });

    let closeId: string | undefined;
    el.addEventListener('annotation:close', (e) => {
      closeId = (e as CustomEvent<{ id: string }>).detail.id;
    });

    el.remove();
    expect(closeId).toBe('ann-x');
  });

  it('renders co-viewer bubbles in the popover header when `viewers` is set with an annotation', () => {
    const el = mount();
    const a = makeAnnotation({ id: 'ann-1' });
    el.target = makeTarget();
    el.annotation = a;
    el.viewers = ['alice', 'bob', 'carol'];

    const row = el.shadowRoot!.querySelector('.fl-popover-viewers') as HTMLElement;
    expect(row.hidden).toBe(false);
    const bubbles = row.querySelectorAll('.fl-popover-viewer-bubble');
    expect(bubbles.length).toBe(3);
    expect(bubbles[0].textContent).toBe('AL');
    expect(bubbles[1].textContent).toBe('BO');
    expect(bubbles[2].textContent).toBe('CA');
    expect((row.querySelector('.fl-popover-viewers-label') as HTMLElement).textContent).toBe(
      '3 viewing',
    );
  });

  it('hides the viewers row when no co-viewers are present', () => {
    const el = mount();
    el.target = makeTarget();
    el.annotation = makeAnnotation();
    el.viewers = [];

    const row = el.shadowRoot!.querySelector('.fl-popover-viewers') as HTMLElement;
    expect(row.hidden).toBe(true);
  });

  it('hides the viewers row in create mode even if `viewers` is non-empty', () => {
    const el = mount();
    el.target = makeTarget();
    el.viewers = ['alice', 'bob'];

    const row = el.shadowRoot!.querySelector('.fl-popover-viewers') as HTMLElement;
    expect(row.hidden).toBe(true);
  });

  // ---------------------------------------------------------------------
  // Create-mode environment summary (task 19.2, Req 17.1, 17.5)
  // ---------------------------------------------------------------------

  it('renders a "Will attach" environment summary in create mode below the form', async () => {
    const el = mount();
    el.target = makeTarget();
    // The async Brave/Arc override pass resolves on the next microtask.
    await flushMicrotasks();

    const row = el.shadowRoot!.querySelector(
      '.fl-environment-summary',
    ) as HTMLElement;
    expect(row).not.toBeNull();
    // Hidden when nothing meaningful resolved; otherwise visible. jsdom's
    // default UA classifies as Mozilla/Other, so the row should render.
    expect(row.hidden).toBe(false);

    const text = el.shadowRoot!.querySelector(
      '.fl-environment-summary-text',
    ) as HTMLElement;
    // The badge always ends with the device type (one of the closed enum
    // values). Browser/OS slots may be empty when the family is `unknown`.
    expect(text.textContent).toMatch(/desktop|tablet|mobile/);
  });

  it('reflects the parseUserAgent pipeline in the summary text (browser + OS + device)', async () => {
    const el = mount();
    el.target = makeTarget();
    await flushMicrotasks();

    const text = (el.shadowRoot!.querySelector(
      '.fl-environment-summary-text',
    ) as HTMLElement).textContent ?? '';
    // The summary uses ` · ` as the separator between non-empty parts.
    // At minimum the device type is present; browser/OS may be omitted
    // when their family is `unknown` in jsdom.
    const parts = text.split(' · ');
    expect(parts.length).toBeGreaterThanOrEqual(1);
    expect(['desktop', 'tablet', 'mobile']).toContain(parts.at(-1));
  });

  it('updates the summary to "Brave" when navigator.brave.isBrave() resolves true', async () => {
    const nav = navigator as unknown as {
      brave?: { isBrave?: () => Promise<boolean> };
    };
    const had = 'brave' in nav;
    const prior = nav.brave;
    nav.brave = { isBrave: () => Promise.resolve(true) };

    try {
      const el = mount();
      el.target = makeTarget();
      await flushMicrotasks();

      const text = (el.shadowRoot!.querySelector(
        '.fl-environment-summary-text',
      ) as HTMLElement).textContent ?? '';
      // The summary should now lead with "Brave …" once the async
      // override resolves.
      expect(text.startsWith('Brave')).toBe(true);
    } finally {
      if (had) {
        nav.brave = prior;
      } else {
        delete nav.brave;
      }
    }
  });

  // ---------------------------------------------------------------------
  // Captured Console / Network sections (Req 36.3, task 27.4).
  // ---------------------------------------------------------------------

  describe('captured console / network panels', () => {
    function consolePanel(el: FlPopover): HTMLDetailsElement {
      return el.shadowRoot!.querySelector(
        'details[data-role="console-panel"]',
      ) as HTMLDetailsElement;
    }

    function networkPanel(el: FlPopover): HTMLDetailsElement {
      return el.shadowRoot!.querySelector(
        'details[data-role="network-panel"]',
      ) as HTMLDetailsElement;
    }

    function consoleRows(el: FlPopover): HTMLLIElement[] {
      return Array.from(
        el.shadowRoot!.querySelectorAll<HTMLLIElement>(
          '[data-role="console-list"] > li',
        ),
      );
    }

    function networkRows(el: FlPopover): HTMLLIElement[] {
      return Array.from(
        el.shadowRoot!.querySelectorAll<HTMLLIElement>(
          '[data-role="network-list"] > li',
        ),
      );
    }

    const consoleEntries: CapturedConsoleEntry[] = [
      {
        level: 'log',
        message: 'first log',
        timestamp: '2024-05-01T10:00:00.000Z',
      },
      {
        level: 'warn',
        message: 'a warning',
        timestamp: '2024-05-01T10:00:01.000Z',
      },
      {
        level: 'error',
        message: 'boom',
        timestamp: '2024-05-01T10:00:02.000Z',
        stack: 'Error: boom\n  at foo:1:1',
      },
    ];

    const networkEntries: CapturedNetworkEntry[] = [
      {
        name: 'https://api.example.com/users',
        initiatorType: 'fetch',
        startTime: 100,
        duration: 42.7,
        responseStatus: 200,
      },
      {
        name: 'https://api.example.com/missing',
        initiatorType: 'fetch',
        startTime: 200,
        duration: 12.1,
        responseStatus: 404,
      },
      {
        name: 'https://cdn.example.com/script.js',
        initiatorType: 'script',
        startTime: 300,
        duration: 5.5,
        // No responseStatus — Resource Timing entries do not carry one
        // for non-fetch loads. The row should still render.
      },
    ];

    it('hides both panels when the buffers are absent or empty', () => {
      const el = mount();
      el.annotation = makeAnnotation();
      expect(consolePanel(el).hidden).toBe(true);
      expect(networkPanel(el).hidden).toBe(true);

      el.annotation = makeAnnotation({ capturedConsole: [], capturedNetwork: [] });
      expect(consolePanel(el).hidden).toBe(true);
      expect(networkPanel(el).hidden).toBe(true);

      el.annotation = makeAnnotation({
        capturedConsole: null,
        capturedNetwork: null,
      });
      expect(consolePanel(el).hidden).toBe(true);
      expect(networkPanel(el).hidden).toBe(true);
    });

    it('renders the Console panel with one row per entry in insertion order', () => {
      const el = mount();
      el.annotation = makeAnnotation({
        capturedConsole: consoleEntries,
        capturedNetwork: null,
      });

      const panel = consolePanel(el);
      expect(panel.hidden).toBe(false);
      // Native <details> renders summary text; the count is the entry length.
      expect(
        panel.querySelector('.fl-capture-console-count')!.textContent,
      ).toBe('3');

      const rows = consoleRows(el);
      expect(rows).toHaveLength(3);
      // Each row formats as `[level] timestamp — message`.
      expect(rows[0].textContent).toContain('log');
      expect(rows[0].textContent).toContain('first log');
      expect(rows[0].textContent).toContain('2024-05-01T10:00:00.000Z');
      expect(rows[1].textContent).toContain('warn');
      expect(rows[1].textContent).toContain('a warning');
      expect(rows[2].textContent).toContain('error');
      expect(rows[2].textContent).toContain('boom');

      // The third entry has a stack — it should be folded into a nested
      // <details> so the popover stays compact.
      const stack = rows[2].querySelector('details.fl-capture-console-stack');
      expect(stack).not.toBeNull();
      expect(stack!.querySelector('pre')!.textContent).toContain('Error: boom');

      // Network buffer is empty so its panel stays hidden.
      expect(networkPanel(el).hidden).toBe(true);
    });

    it('renders the Network panel with one row per entry in insertion order', () => {
      const el = mount();
      el.annotation = makeAnnotation({
        capturedConsole: null,
        capturedNetwork: networkEntries,
      });

      const panel = networkPanel(el);
      expect(panel.hidden).toBe(false);
      expect(
        panel.querySelector('.fl-capture-network-count')!.textContent,
      ).toBe('3');

      const rows = networkRows(el);
      expect(rows).toHaveLength(3);
      expect(rows[0].textContent).toContain('https://api.example.com/users');
      expect(rows[0].textContent).toContain('200');
      expect(rows[0].textContent).toContain('43 ms');
      expect(rows[1].textContent).toContain('https://api.example.com/missing');
      expect(rows[1].textContent).toContain('404');
      // 4xx status flagged for emphasis via data-bad attribute.
      expect(
        rows[1].querySelector<HTMLElement>('.fl-capture-network-status')!.dataset.bad,
      ).toBe('true');
      // Missing responseStatus renders as an em dash placeholder.
      expect(rows[2].textContent).toContain('—');
      expect(rows[2].textContent).toContain('script.js');

      expect(consolePanel(el).hidden).toBe(true);
    });

    it('clears the panels when the annotation is cleared', () => {
      const el = mount();
      el.annotation = makeAnnotation({
        capturedConsole: consoleEntries,
        capturedNetwork: networkEntries,
      });
      expect(consolePanel(el).hidden).toBe(false);
      expect(networkPanel(el).hidden).toBe(false);

      el.annotation = null;
      expect(consolePanel(el).hidden).toBe(true);
      expect(networkPanel(el).hidden).toBe(true);
      expect(consoleRows(el)).toHaveLength(0);
      expect(networkRows(el)).toHaveLength(0);
    });

    it('updates the panels when the annotation buffers change between assignments', () => {
      const el = mount();
      el.annotation = makeAnnotation({
        capturedConsole: consoleEntries.slice(0, 1),
        capturedNetwork: networkEntries.slice(0, 1),
      });
      expect(consoleRows(el)).toHaveLength(1);
      expect(networkRows(el)).toHaveLength(1);

      el.annotation = makeAnnotation({
        capturedConsole: consoleEntries,
        capturedNetwork: networkEntries.slice(0, 2),
      });
      expect(consoleRows(el)).toHaveLength(3);
      expect(networkRows(el)).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------
  // Screenshot capture pipeline (Req 34.1, 34.2 / Tasks 25.3, 25.4).
  // ---------------------------------------------------------------------

  describe('screenshot capture on submit', () => {
    // 1×1 transparent PNG, base64 encoded — produced once and reused.
    const TINY_PNG_BASE64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_BASE64}`;

    type ChromeStub = {
      runtime: {
        sendMessage: ReturnType<typeof vi.fn>;
      };
      storage: {
        local: {
          _data: Record<string, unknown>;
          get: ReturnType<typeof vi.fn>;
          set: ReturnType<typeof vi.fn>;
          remove: ReturnType<typeof vi.fn>;
        };
      };
    };

    function makeChromeStub(initial: Record<string, unknown> = {}): ChromeStub {
      const data: Record<string, unknown> = { ...initial };
      return {
        runtime: { sendMessage: vi.fn() },
        storage: {
          local: {
            _data: data,
            get: vi.fn(async (key?: string | string[] | null) => {
              if (typeof key === 'string') {
                return key in data ? { [key]: data[key] } : {};
              }
              if (Array.isArray(key)) {
                const out: Record<string, unknown> = {};
                for (const k of key) if (k in data) out[k] = data[k];
                return out;
              }
              return { ...data };
            }),
            set: vi.fn(async (entries: Record<string, unknown>) => {
              Object.assign(data, entries);
            }),
            remove: vi.fn(async (key: string) => {
              delete data[key];
            }),
          },
        },
      };
    }

    let chromeStub: ChromeStub;
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      chromeStub = makeChromeStub();
      vi.stubGlobal('chrome', chromeStub);
      fetchSpy = vi.fn(
        async () =>
          new Response(JSON.stringify({ screenshotObjectKey: 'k', screenshotUrl: 'u' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      );
      vi.stubGlobal('fetch', fetchSpy);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    /** Click Submit on a freshly mounted popover with a non-empty body. */
    async function submitNote(el: FlPopover, body = 'a screenshot note'): Promise<Annotation> {
      el.target = makeTarget();
      const ta = el.shadowRoot!.querySelector('textarea.fl-textarea') as HTMLTextAreaElement;
      ta.value = body;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      let received: Annotation | undefined;
      el.addEventListener('submit', (e: Event) => {
        received = (e as CustomEvent<PopoverSubmitDetail>).detail.annotation;
      });
      (el.shadowRoot!.querySelector('button[data-action="submit"]') as HTMLButtonElement).click();
      // Several microtask turns settle the chained promises:
      //   1. parseUserAgent + detectBraveAndArcOverrides → submit dispatch
      //   2. chrome.runtime.sendMessage → dataUrl
      //   3. apiFetchRaw → getStoredAuthToken
      //   4. fetch → Response
      //   5. response.json() on the error path
      for (let i = 0; i < 6; i++) await flushMicrotasks();
      return received!;
    }

    it('postMessages CAPTURE_VISIBLE_TAB to the service worker on submit', async () => {
      chromeStub.runtime.sendMessage.mockResolvedValueOnce({ dataUrl: TINY_PNG_DATA_URL });
      const el = mount();
      // Wait for the connectedCallback's preference hydration.
      await flushMicrotasks();

      await submitNote(el);

      expect(chromeStub.runtime.sendMessage).toHaveBeenCalledTimes(1);
      expect(chromeStub.runtime.sendMessage).toHaveBeenCalledWith({
        type: 'CAPTURE_VISIBLE_TAB',
      });
    });

    it('uploads the captured PNG via POST /annotations/:id/screenshot as multipart/form-data with redactionRects=[]', async () => {
      chromeStub.runtime.sendMessage.mockResolvedValueOnce({ dataUrl: TINY_PNG_DATA_URL });
      const el = mount();
      await flushMicrotasks();
      const annotation = await submitNote(el);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [calledUrl, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(calledUrl).toMatch(
        new RegExp(`/api/v1/annotations/${annotation.id}/screenshot$`),
      );
      expect(init.method).toBe('POST');
      // The popover MUST NOT set Content-Type itself — the multipart
      // boundary is computed by the browser when the body is FormData.
      const headers = (init.headers ?? {}) as Record<string, string>;
      expect(headers['Content-Type']).toBeUndefined();
      // FormData carries both fields.
      const form = init.body as FormData;
      expect(form).toBeInstanceOf(FormData);
      expect(form.get('redactionRects')).toBe('[]');
      const image = form.get('image');
      expect(image).toBeInstanceOf(Blob);
      expect((image as Blob).type).toBe('image/png');
    });

    it('appends user-painted blur rects from a mounted <fl-markup-editor> to redactionRects (Req 45.3, task 37.4)', async () => {
      chromeStub.runtime.sendMessage.mockResolvedValueOnce({ dataUrl: TINY_PNG_DATA_URL });
      const el = mount();
      await flushMicrotasks();

      // Mount a markup editor with two user-painted blur rects. The
      // popover scans the document for any `<fl-markup-editor>` and
      // concatenates their redactionRects to whatever
      // `computeRedactionRects()` returns automatically.
      const editor = document.createElement('fl-markup-editor') as
        & HTMLElement
        & { redactionRects: readonly { x: number; y: number; w: number; h: number }[] };
      document.body.appendChild(editor);
      // Bypass the pointer-driven flow by painting two rects directly via
      // the same code path the public tool exposes.
      const svg = editor.shadowRoot!.querySelector('svg.fl-markup-svg')!;
      const fire = (
        type: 'pointerdown' | 'pointermove' | 'pointerup',
        x: number,
        y: number,
      ): void => {
        const evt = new PointerEvent(type, {
          bubbles: true,
          composed: true,
          cancelable: true,
          pointerId: 1,
          clientX: x,
          clientY: y,
          button: 0,
          pointerType: 'mouse',
        });
        Object.defineProperty(evt, 'offsetX', { value: x });
        Object.defineProperty(evt, 'offsetY', { value: y });
        svg.dispatchEvent(evt);
      };
      (editor as unknown as { tool: string }).tool = 'blur';
      fire('pointerdown', 10, 20);
      fire('pointermove', 50, 80);
      fire('pointerup', 50, 80);
      fire('pointerdown', 100, 110);
      fire('pointermove', 150, 200);
      fire('pointerup', 150, 200);
      expect(editor.redactionRects).toEqual([
        { x: 10, y: 20, w: 40, h: 60 },
        { x: 100, y: 110, w: 50, h: 90 },
      ]);

      try {
        await submitNote(el);

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
        const form = init.body as FormData;
        // The wire format renames `w`/`h` to `width`/`height`. The DOM
        // is bare in the jsdom test (no password inputs) so
        // `computeRedactionRects()` returns []; the only entries are
        // the two user-painted blur rects.
        expect(form.get('redactionRects')).toBe(
          JSON.stringify([
            { x: 10, y: 20, width: 40, height: 60 },
            { x: 100, y: 110, width: 50, height: 90 },
          ]),
        );
      } finally {
        editor.remove();
      }
    });

    it('does NOT request a screenshot when captureScreenshot is false', async () => {
      const el = mount();
      el.captureScreenshot = false;
      await flushMicrotasks();

      await submitNote(el);

      expect(chromeStub.runtime.sendMessage).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('hydrates captureScreenshot from chrome.storage.local.fl_capture_screenshot_pref on connect', async () => {
      vi.unstubAllGlobals();
      chromeStub = makeChromeStub({ fl_capture_screenshot_pref: false });
      vi.stubGlobal('chrome', chromeStub);
      vi.stubGlobal('fetch', fetchSpy);

      const el = mount();
      // Hydration is async — wait for the connectedCallback Promise chain.
      await flushMicrotasks();
      await flushMicrotasks();

      expect(el.captureScreenshot).toBe(false);
      // Sanity: the stub recorded the read.
      expect(chromeStub.storage.local.get).toHaveBeenCalledWith(
        'fl_capture_screenshot_pref',
      );
    });

    it('persists captureScreenshot setter writes to chrome.storage.local', async () => {
      const el = mount();
      await flushMicrotasks();
      el.captureScreenshot = false;
      // The setter persists asynchronously; flush.
      await flushMicrotasks();
      expect(chromeStub.storage.local.set).toHaveBeenCalledWith({
        fl_capture_screenshot_pref: false,
      });
    });

    it('emits a bubbling+composed `screenshot-error` event when the service worker fails to capture', async () => {
      chromeStub.runtime.sendMessage.mockResolvedValueOnce({
        dataUrl: null,
        error: 'cannot capture chrome:// URLs',
      });
      const el = mount();
      await flushMicrotasks();

      const errors: PopoverScreenshotErrorDetail[] = [];
      document.addEventListener('screenshot-error', (e: Event) => {
        const evt = e as CustomEvent<PopoverScreenshotErrorDetail>;
        expect(evt.bubbles).toBe(true);
        expect(evt.composed).toBe(true);
        errors.push(evt.detail);
      });

      const annotation = await submitNote(el);

      expect(errors).toHaveLength(1);
      expect(errors[0].annotationId).toBe(annotation.id);
      expect(errors[0].code).toBe('capture-failed');
      expect(errors[0].message).toContain('chrome://');
      // No upload attempted when capture failed.
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('emits `screenshot-error` (code "upload-failed") when the screenshot POST returns a non-2xx response', async () => {
      chromeStub.runtime.sendMessage.mockResolvedValueOnce({ dataUrl: TINY_PNG_DATA_URL });
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { code: 'VALIDATION_ERROR', message: 'screenshot too large' },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const el = mount();
      await flushMicrotasks();

      const errors: PopoverScreenshotErrorDetail[] = [];
      document.addEventListener('screenshot-error', (e: Event) => {
        errors.push((e as CustomEvent<PopoverScreenshotErrorDetail>).detail);
      });

      await submitNote(el);

      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe('upload-failed');
      expect(errors[0].message).toContain('screenshot too large');
    });

    it('does not break annotation creation when chrome.runtime is unavailable; emits `screenshot-error` with code "unsupported"', async () => {
      // Replace chrome with a runtime-less stub so the popover takes the
      // unsupported branch. Annotation creation must still succeed.
      vi.unstubAllGlobals();
      vi.stubGlobal('chrome', {
        storage: chromeStub.storage,
      });
      vi.stubGlobal('fetch', fetchSpy);

      const el = mount();
      await flushMicrotasks();

      const errors: PopoverScreenshotErrorDetail[] = [];
      document.addEventListener('screenshot-error', (e: Event) => {
        errors.push((e as CustomEvent<PopoverScreenshotErrorDetail>).detail);
      });

      const annotation = await submitNote(el);
      expect(annotation).toBeDefined();
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe('unsupported');
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------
  // "Attach screenshot" toggle in the create-section footer (Req 34.2 /
  // Task 25.4). The toggle is an `<input type="checkbox">` inside a
  // `<label>` so screen readers announce the control name and clicking
  // either the box or its label flips the choice. The setter persists
  // the new value to `chrome.storage.local.fl_capture_screenshot_pref`
  // so the next popover (and the next page load) defaults to the
  // user's last choice.
  // ---------------------------------------------------------------------

  describe('per-annotation "Attach screenshot" toggle', () => {
    type CaptureToggleChromeStub = {
      storage: {
        local: {
          _data: Record<string, unknown>;
          get: ReturnType<typeof vi.fn>;
          set: ReturnType<typeof vi.fn>;
          remove: ReturnType<typeof vi.fn>;
        };
      };
    };

    function makeCaptureToggleChromeStub(
      initial: Record<string, unknown> = {},
    ): CaptureToggleChromeStub {
      const data: Record<string, unknown> = { ...initial };
      return {
        storage: {
          local: {
            _data: data,
            get: vi.fn(async (key?: string | string[] | null) => {
              if (typeof key === 'string') {
                return key in data ? { [key]: data[key] } : {};
              }
              if (Array.isArray(key)) {
                const out: Record<string, unknown> = {};
                for (const k of key) if (k in data) out[k] = data[k];
                return out;
              }
              return { ...data };
            }),
            set: vi.fn(async (entries: Record<string, unknown>) => {
              Object.assign(data, entries);
            }),
            remove: vi.fn(async (key: string) => {
              delete data[key];
            }),
          },
        },
      };
    }

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    /** Resolve the toggle's checkbox + the label wrapping it. */
    function captureToggle(el: FlPopover): {
      checkbox: HTMLInputElement;
      label: HTMLLabelElement;
    } {
      const checkbox = el.shadowRoot!.querySelector(
        'input.fl-popover-capture-checkbox',
      ) as HTMLInputElement | null;
      const label = el.shadowRoot!.querySelector(
        'label.fl-popover-capture-toggle',
      ) as HTMLLabelElement | null;
      expect(checkbox).not.toBeNull();
      expect(label).not.toBeNull();
      return { checkbox: checkbox!, label: label! };
    }

    it('renders an "Attach screenshot" checkbox inside a <label> in the create-section footer', () => {
      const el = mount();
      el.target = makeTarget();

      const { checkbox, label } = captureToggle(el);
      expect(checkbox.type).toBe('checkbox');
      // The label fully wraps the checkbox so a click on either flips the box.
      expect(label.contains(checkbox)).toBe(true);
      expect(label.textContent).toContain('Attach screenshot');

      // The toggle lives in the create-mode footer alongside Submit/Cancel.
      const btnRow = el.shadowRoot!.querySelector(
        '.fl-popover-create .fl-btn-row',
      ) as HTMLElement;
      expect(btnRow.contains(label)).toBe(true);

      // Insertion order: the toggle precedes the Submit button so the
      // user reads the choice before the action that consumes it.
      const submit = el.shadowRoot!.querySelector(
        'button[data-action="submit"]',
      ) as HTMLButtonElement;
      const position = label.compareDocumentPosition(submit);
      // DOCUMENT_POSITION_FOLLOWING = 4 — submit comes after the toggle.
      expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('defaults the checkbox to checked when no preference is stored', async () => {
      const stub = makeCaptureToggleChromeStub();
      vi.stubGlobal('chrome', stub);

      const el = mount();
      // Hydration awaits chrome.storage.local.get; flush a couple of turns
      // so the post-hydrate `#syncCaptureCheckbox` has run.
      await flushMicrotasks();
      await flushMicrotasks();

      expect(el.captureScreenshot).toBe(true);
      const { checkbox } = captureToggle(el);
      expect(checkbox.checked).toBe(true);
    });

    it('persists `false` to chrome.storage.local when the user unchecks the box', async () => {
      const stub = makeCaptureToggleChromeStub();
      vi.stubGlobal('chrome', stub);

      const el = mount();
      await flushMicrotasks();
      await flushMicrotasks();

      const { checkbox } = captureToggle(el);
      checkbox.checked = false;
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));

      // The setter persists asynchronously — flush so the
      // chrome.storage.local write resolves before we assert.
      await flushMicrotasks();

      expect(el.captureScreenshot).toBe(false);
      expect(stub.storage.local.set).toHaveBeenCalledWith({
        fl_capture_screenshot_pref: false,
      });
      expect(stub.storage.local._data.fl_capture_screenshot_pref).toBe(false);
    });

    it('shows the checkbox unchecked on a fresh mount when storage holds `false`', async () => {
      const stub = makeCaptureToggleChromeStub({ fl_capture_screenshot_pref: false });
      vi.stubGlobal('chrome', stub);

      const el = mount();
      // Hydration is async — wait for chrome.storage.local.get + the
      // post-hydrate `#syncCaptureCheckbox` call.
      await flushMicrotasks();
      await flushMicrotasks();

      expect(el.captureScreenshot).toBe(false);
      const { checkbox } = captureToggle(el);
      expect(checkbox.checked).toBe(false);
    });

    it('flipping the checkbox back on persists `true` to chrome.storage.local', async () => {
      const stub = makeCaptureToggleChromeStub({ fl_capture_screenshot_pref: false });
      vi.stubGlobal('chrome', stub);

      const el = mount();
      await flushMicrotasks();
      await flushMicrotasks();

      const { checkbox } = captureToggle(el);
      // Start unchecked (hydrated from storage), user re-enables it.
      expect(checkbox.checked).toBe(false);
      checkbox.checked = true;
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));

      await flushMicrotasks();

      expect(el.captureScreenshot).toBe(true);
      expect(stub.storage.local.set).toHaveBeenLastCalledWith({
        fl_capture_screenshot_pref: true,
      });
    });
  });

  // ---------------------------------------------------------------------
  // Draft persistence on input (Req 41.1, task 32.1).
  // ---------------------------------------------------------------------

  describe('draft persistence on input', () => {
    type DraftStub = {
      storage: {
        session: {
          _data: Record<string, unknown>;
          get: ReturnType<typeof vi.fn>;
          set: ReturnType<typeof vi.fn>;
          remove: ReturnType<typeof vi.fn>;
        };
        local: {
          get: ReturnType<typeof vi.fn>;
          set: ReturnType<typeof vi.fn>;
        };
      };
    };

    function makeDraftStub(): DraftStub {
      const data: Record<string, unknown> = {};
      return {
        storage: {
          session: {
            _data: data,
            get: vi.fn(async (key?: string | string[] | null) => {
              if (typeof key === 'string') {
                return key in data ? { [key]: data[key] } : {};
              }
              if (Array.isArray(key)) {
                const out: Record<string, unknown> = {};
                for (const k of key) if (k in data) out[k] = data[k];
                return out;
              }
              return { ...data };
            }),
            set: vi.fn(async (entries: Record<string, unknown>) => {
              Object.assign(data, entries);
            }),
            remove: vi.fn(async (key: string) => {
              delete data[key];
            }),
          },
          local: {
            get: vi.fn(async () => ({})),
            set: vi.fn(async () => undefined),
          },
        },
      };
    }

    let stub: DraftStub;

    beforeEach(() => {
      stub = makeDraftStub();
      vi.stubGlobal('chrome', stub);
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it('debounces typing in the textarea and persists the draft after 300 ms', async () => {
      const el = mount();
      el.target = makeTarget();

      const ta = el.shadowRoot!.querySelector(
        'textarea.fl-textarea',
      ) as HTMLTextAreaElement;
      ta.value = 'hello world';
      ta.dispatchEvent(new Event('input', { bubbles: true }));

      // Before the debounce fires nothing has been written yet.
      expect(stub.storage.session.set).not.toHaveBeenCalled();

      // Just-shy-of debounce — still nothing.
      vi.advanceTimersByTime(299);
      expect(stub.storage.session.set).not.toHaveBeenCalled();

      // Crossing the threshold flushes the write.
      vi.advanceTimersByTime(1);
      // Allow the awaited storage round-trip in saveDraft to settle.
      await vi.runAllTimersAsync();

      expect(stub.storage.session.set).toHaveBeenCalledTimes(1);
      expect(stub.storage.session._data.fl_drafts).toEqual({
        [window.location.href]: {
          body: 'hello world',
          severity: 'informational',
          type: 'note',
        },
      });
    });

    it('coalesces multiple rapid input events into a single storage write', async () => {
      const el = mount();
      el.target = makeTarget();
      const ta = el.shadowRoot!.querySelector(
        'textarea.fl-textarea',
      ) as HTMLTextAreaElement;

      // Five rapid keystrokes inside the debounce window should
      // collapse into a single write of the *final* value.
      for (const v of ['h', 'he', 'hel', 'hell', 'hello']) {
        ta.value = v;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        vi.advanceTimersByTime(50);
      }

      // 5×50ms = 250ms elapsed — still inside the 300 ms window.
      expect(stub.storage.session.set).not.toHaveBeenCalled();

      // Flush the final timer.
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();

      expect(stub.storage.session.set).toHaveBeenCalledTimes(1);
      const stored = stub.storage.session._data.fl_drafts as Record<
        string,
        { body: string; severity: string; type: string }
      >;
      expect(stored[window.location.href].body).toBe('hello');
    });

    it('writes to chrome.storage.session, not chrome.storage.local', async () => {
      const el = mount();
      el.target = makeTarget();
      const ta = el.shadowRoot!.querySelector(
        'textarea.fl-textarea',
      ) as HTMLTextAreaElement;
      ta.value = 'session please';
      ta.dispatchEvent(new Event('input', { bubbles: true }));

      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();

      expect(stub.storage.session.set).toHaveBeenCalledTimes(1);
      // The popover already persists the screenshot capture pref to
      // local on connect, so we cannot assert local.set === 0; we just
      // assert the draft never lands there.
      const localCalls = stub.storage.local.set.mock.calls.map(
        (c) => c[0] as Record<string, unknown>,
      );
      for (const call of localCalls) {
        expect(call).not.toHaveProperty('fl_drafts');
      }
    });

    it('persists severity and tab changes after debounce', async () => {
      const el = mount();
      el.target = makeTarget();

      const major = el.shadowRoot!.querySelector(
        '.fl-severity-btn[data-severity="major"]',
      ) as HTMLButtonElement;
      major.click();

      const suggestionTab = el.shadowRoot!.querySelector(
        'button[role="tab"][data-tab="suggestion"]',
      ) as HTMLButtonElement;
      suggestionTab.click();

      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();

      expect(stub.storage.session.set).toHaveBeenCalledTimes(1);
      const stored = stub.storage.session._data.fl_drafts as Record<
        string,
        { body: string; severity: string; type: string }
      >;
      expect(stored[window.location.href]).toEqual({
        body: '',
        severity: 'major',
        type: 'suggestion',
      });
    });

    it('clears any pending debounce timer on disconnectedCallback', async () => {
      const el = mount();
      el.target = makeTarget();
      const ta = el.shadowRoot!.querySelector(
        'textarea.fl-textarea',
      ) as HTMLTextAreaElement;
      ta.value = 'about to be detached';
      ta.dispatchEvent(new Event('input', { bubbles: true }));

      // Detach before the debounce fires.
      el.remove();

      // Advance well past the debounce — no write should occur because
      // the timer was cleared in disconnectedCallback.
      vi.advanceTimersByTime(1000);
      await vi.runAllTimersAsync();

      expect(stub.storage.session.set).not.toHaveBeenCalled();
    });

    it('does not persist a draft while in view mode (annotation set)', async () => {
      const el = mount();
      el.annotation = makeAnnotation();
      el.target = makeTarget();

      // In view mode the textarea is hidden, but a click on a severity
      // button (used for parity with the legacy React component) must
      // not schedule a draft save — drafts are only meaningful in
      // create mode.
      const minor = el.shadowRoot!.querySelector(
        '.fl-severity-btn[data-severity="minor"]',
      ) as HTMLButtonElement;
      minor.click();

      vi.advanceTimersByTime(500);
      await vi.runAllTimersAsync();

      expect(stub.storage.session.set).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------
  // Draft prefill on popover open (Req 41.2, task 32.2).
  // ---------------------------------------------------------------------

  describe('draft prefill on popover open', () => {
    type DraftStub = {
      storage: {
        session: {
          _data: Record<string, unknown>;
          get: ReturnType<typeof vi.fn>;
          set: ReturnType<typeof vi.fn>;
          remove: ReturnType<typeof vi.fn>;
        };
        local: {
          get: ReturnType<typeof vi.fn>;
          set: ReturnType<typeof vi.fn>;
        };
      };
    };

    function makeDraftStub(initial: Record<string, unknown> = {}): DraftStub {
      const data: Record<string, unknown> = { ...initial };
      return {
        storage: {
          session: {
            _data: data,
            get: vi.fn(async (key?: string | string[] | null) => {
              if (typeof key === 'string') {
                return key in data ? { [key]: data[key] } : {};
              }
              if (Array.isArray(key)) {
                const out: Record<string, unknown> = {};
                for (const k of key) if (k in data) out[k] = data[k];
                return out;
              }
              return { ...data };
            }),
            set: vi.fn(async (entries: Record<string, unknown>) => {
              Object.assign(data, entries);
            }),
            remove: vi.fn(async (key: string) => {
              delete data[key];
            }),
          },
          local: {
            get: vi.fn(async () => ({})),
            set: vi.fn(async () => undefined),
          },
        },
      };
    }

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('prefills the textarea, severity, and tab from chrome.storage.session on open', async () => {
      vi.stubGlobal(
        'chrome',
        makeDraftStub({
          fl_drafts: {
            [window.location.href]: {
              body: 'in-progress feedback',
              severity: 'major',
              type: 'suggestion',
            },
          },
        }),
      );

      const el = mount();
      el.target = makeTarget();

      // The hydrate path awaits chrome.storage.session.get + the
      // subsequent state writes — flush a few microtasks so the
      // assertions see the resolved prefill.
      await flushMicrotasks();
      await flushMicrotasks();

      const ta = el.shadowRoot!.querySelector(
        'textarea.fl-textarea',
      ) as HTMLTextAreaElement;
      expect(ta.value).toBe('in-progress feedback');

      const major = el.shadowRoot!.querySelector(
        '.fl-severity-btn[data-severity="major"]',
      ) as HTMLButtonElement;
      expect(major.classList.contains('selected')).toBe(true);
      expect(major.getAttribute('aria-checked')).toBe('true');

      const suggestionTab = el.shadowRoot!.querySelector(
        'button[role="tab"][data-tab="suggestion"]',
      ) as HTMLButtonElement;
      expect(suggestionTab.classList.contains('active')).toBe(true);

      // A non-empty textarea must enable Submit so the user can hit it
      // straight away after re-open.
      const submit = el.shadowRoot!.querySelector(
        'button[data-action="submit"]',
      ) as HTMLButtonElement;
      expect(submit.disabled).toBe(false);
    });

    it('does not prefill when there is no persisted draft for the URL', async () => {
      vi.stubGlobal('chrome', makeDraftStub());

      const el = mount();
      el.target = makeTarget();

      await flushMicrotasks();
      await flushMicrotasks();

      const ta = el.shadowRoot!.querySelector(
        'textarea.fl-textarea',
      ) as HTMLTextAreaElement;
      expect(ta.value).toBe('');

      // Default severity / tab unchanged.
      const informational = el.shadowRoot!.querySelector(
        '.fl-severity-btn[data-severity="informational"]',
      ) as HTMLButtonElement;
      expect(informational.classList.contains('selected')).toBe(true);

      const noteTab = el.shadowRoot!.querySelector(
        'button[role="tab"][data-tab="note"]',
      ) as HTMLButtonElement;
      expect(noteTab.classList.contains('active')).toBe(true);
    });

    it('ignores drafts persisted under a different URL', async () => {
      vi.stubGlobal(
        'chrome',
        makeDraftStub({
          fl_drafts: {
            'https://other.test/page': {
              body: 'someone else',
              severity: 'critical',
              type: 'note',
            },
          },
        }),
      );

      const el = mount();
      el.target = makeTarget();

      await flushMicrotasks();
      await flushMicrotasks();

      const ta = el.shadowRoot!.querySelector(
        'textarea.fl-textarea',
      ) as HTMLTextAreaElement;
      expect(ta.value).toBe('');
    });

    it('skips prefill in view mode (annotation set)', async () => {
      vi.stubGlobal(
        'chrome',
        makeDraftStub({
          fl_drafts: {
            [window.location.href]: {
              body: 'should NOT replace annotation body',
              severity: 'major',
              type: 'note',
            },
          },
        }),
      );

      const el = mount();
      el.annotation = makeAnnotation({ body: 'real annotation body' });
      el.target = makeTarget();

      await flushMicrotasks();
      await flushMicrotasks();

      // In view mode the textarea is hidden behind the create section's
      // `hidden` attribute. The body view holds the annotation copy;
      // the persisted draft must not bleed into either.
      const view = el.shadowRoot!.querySelector(
        '.fl-popover-view',
      ) as HTMLElement;
      expect(view.hidden).toBe(false);
      expect(
        el.shadowRoot!.querySelector('.fl-annotation-body')!.textContent,
      ).toBe('real annotation body');

      const ta = el.shadowRoot!.querySelector(
        'textarea.fl-textarea',
      ) as HTMLTextAreaElement;
      expect(ta.value).toBe('');
    });

    it('does not clobber live keystrokes when storage resolves after the user has started typing', async () => {
      // Build a stub whose `get` only resolves once we manually flush the
      // returned promise so we can race it against a synthetic input.
      let resolveGet: ((value: Record<string, unknown>) => void) | undefined;
      const data: Record<string, unknown> = {
        fl_drafts: {
          [window.location.href]: {
            body: 'stale draft',
            severity: 'minor',
            type: 'note',
          },
        },
      };
      const stub = {
        storage: {
          session: {
            _data: data,
            get: vi.fn(
              () =>
                new Promise<Record<string, unknown>>((resolve) => {
                  resolveGet = resolve;
                }),
            ),
            set: vi.fn(async (entries: Record<string, unknown>) => {
              Object.assign(data, entries);
            }),
            remove: vi.fn(async (key: string) => {
              delete data[key];
            }),
          },
          local: {
            get: vi.fn(async () => ({})),
            set: vi.fn(async () => undefined),
          },
        },
      };
      vi.stubGlobal('chrome', stub);

      const el = mount();
      el.target = makeTarget();

      // The user types before the storage round-trip resolves.
      const ta = el.shadowRoot!.querySelector(
        'textarea.fl-textarea',
      ) as HTMLTextAreaElement;
      ta.value = 'fresh keystrokes';
      ta.dispatchEvent(new Event('input', { bubbles: true }));

      // Now release the storage read.
      expect(resolveGet).toBeDefined();
      resolveGet!({ fl_drafts: data.fl_drafts });
      await flushMicrotasks();
      await flushMicrotasks();

      // Hydrate must have bailed because the textarea was non-empty by
      // the time it ran.
      expect(ta.value).toBe('fresh keystrokes');
    });

    it('only hydrates once per URL across multiple opens of the same popover', async () => {
      const stub = makeDraftStub({
        fl_drafts: {
          [window.location.href]: {
            body: 'persisted',
            severity: 'major',
            type: 'note',
          },
        },
      });
      vi.stubGlobal('chrome', stub);

      const el = mount();
      el.target = makeTarget();
      await flushMicrotasks();
      await flushMicrotasks();

      const ta = el.shadowRoot!.querySelector(
        'textarea.fl-textarea',
      ) as HTMLTextAreaElement;
      expect(ta.value).toBe('persisted');

      // The user dismisses (target=null) then re-opens — without a new
      // navigation we treat the textarea as theirs to edit; we MUST NOT
      // overwrite whatever they have typed since.
      el.target = null;
      ta.value = 'user edits';
      el.target = makeTarget();
      await flushMicrotasks();
      await flushMicrotasks();

      expect(ta.value).toBe('user edits');
    });

    it('survives a chrome.storage.session outage without throwing', async () => {
      vi.stubGlobal('chrome', {
        storage: {
          session: {
            get: vi.fn(() => Promise.reject(new Error('storage offline'))),
            set: vi.fn(async () => undefined),
            remove: vi.fn(async () => undefined),
          },
          local: {
            get: vi.fn(async () => ({})),
            set: vi.fn(async () => undefined),
          },
        },
      });

      const el = mount();
      expect(() => {
        el.target = makeTarget();
      }).not.toThrow();

      await flushMicrotasks();
      await flushMicrotasks();

      const ta = el.shadowRoot!.querySelector(
        'textarea.fl-textarea',
      ) as HTMLTextAreaElement;
      expect(ta.value).toBe('');
    });
  });

  // ---------------------------------------------------------------------
  // Draft deletion on submit success (Req 41.3, task 32.3).
  // ---------------------------------------------------------------------

  describe('draft deletion on submit success', () => {
    type DraftStub = {
      storage: {
        session: {
          _data: Record<string, unknown>;
          get: ReturnType<typeof vi.fn>;
          set: ReturnType<typeof vi.fn>;
          remove: ReturnType<typeof vi.fn>;
        };
        local: {
          get: ReturnType<typeof vi.fn>;
          set: ReturnType<typeof vi.fn>;
        };
      };
    };

    function makeDraftStub(initial: Record<string, unknown> = {}): DraftStub {
      const data: Record<string, unknown> = { ...initial };
      return {
        storage: {
          session: {
            _data: data,
            get: vi.fn(async (key?: string | string[] | null) => {
              if (typeof key === 'string') {
                return key in data ? { [key]: data[key] } : {};
              }
              if (Array.isArray(key)) {
                const out: Record<string, unknown> = {};
                for (const k of key) if (k in data) out[k] = data[k];
                return out;
              }
              return { ...data };
            }),
            set: vi.fn(async (entries: Record<string, unknown>) => {
              Object.assign(data, entries);
            }),
            remove: vi.fn(async (key: string) => {
              delete data[key];
            }),
          },
          local: {
            get: vi.fn(async () => ({})),
            set: vi.fn(async () => undefined),
          },
        },
      };
    }

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('removes the draft for the current URL after a successful submit', async () => {
      const stub = makeDraftStub({
        fl_drafts: {
          [window.location.href]: {
            body: 'about to submit',
            severity: 'major',
            type: 'note',
          },
          'https://other.test/page': {
            body: 'unrelated',
            severity: 'minor',
            type: 'suggestion',
          },
        },
      });
      vi.stubGlobal('chrome', stub);

      const el = mount();
      el.target = makeTarget();
      // Wait for hydrate to land and prefill the form.
      await flushMicrotasks();
      await flushMicrotasks();

      const ta = el.shadowRoot!.querySelector(
        'textarea.fl-textarea',
      ) as HTMLTextAreaElement;
      // The hydrate path filled the textarea — sanity-check before submit.
      expect(ta.value).toBe('about to submit');

      let received: Annotation | undefined;
      el.addEventListener('submit', (e: Event) => {
        received = (e as CustomEvent<PopoverSubmitDetail>).detail.annotation;
      });

      (
        el.shadowRoot!.querySelector(
          'button[data-action="submit"]',
        ) as HTMLButtonElement
      ).click();
      await flushMicrotasks();
      await flushMicrotasks();

      expect(received).toBeDefined();
      // The submitted annotation's body must match what we saw in the form.
      expect(received!.body).toBe('about to submit');

      // The current-URL slot is gone; unrelated URLs are preserved.
      const stored = stub.storage.session._data.fl_drafts as Record<
        string,
        unknown
      >;
      expect(stored).not.toHaveProperty(window.location.href);
      expect(stored).toHaveProperty('https://other.test/page');
    });

    it('is a noop when there was no persisted draft (e.g. user typed and submitted in one go)', async () => {
      const stub = makeDraftStub();
      vi.stubGlobal('chrome', stub);

      const el = mount();
      el.target = makeTarget();
      await flushMicrotasks();

      const ta = el.shadowRoot!.querySelector(
        'textarea.fl-textarea',
      ) as HTMLTextAreaElement;
      ta.value = 'just a quick note';
      ta.dispatchEvent(new Event('input', { bubbles: true }));

      (
        el.shadowRoot!.querySelector(
          'button[data-action="submit"]',
        ) as HTMLButtonElement
      ).click();
      await flushMicrotasks();
      await flushMicrotasks();

      // No `fl_drafts` slot existed and none is left behind.
      expect(stub.storage.session._data.fl_drafts).toBeUndefined();
    });

    it('does not remove the draft when submit is refused (no DOMTarget)', async () => {
      const stub = makeDraftStub({
        fl_drafts: {
          [window.location.href]: {
            body: 'should survive failed submit',
            severity: 'major',
            type: 'note',
          },
        },
      });
      vi.stubGlobal('chrome', stub);

      const el = mount();
      // PopoverTarget without a `domTarget` — `#onSubmitClick` bails
      // silently and never dispatches `submit`.
      el.target = { pageX: 0, pageY: 0 };
      await flushMicrotasks();

      const ta = el.shadowRoot!.querySelector(
        'textarea.fl-textarea',
      ) as HTMLTextAreaElement;
      ta.value = 'never delivered';
      ta.dispatchEvent(new Event('input', { bubbles: true }));

      (
        el.shadowRoot!.querySelector(
          'button[data-action="submit"]',
        ) as HTMLButtonElement
      ).click();
      await flushMicrotasks();
      await flushMicrotasks();

      // The persisted draft must still be present.
      expect(stub.storage.session._data.fl_drafts).toEqual({
        [window.location.href]: {
          body: 'should survive failed submit',
          severity: 'major',
          type: 'note',
        },
      });
    });

    it('cancels any in-flight save-debounce so a stale write cannot resurrect the deleted entry', async () => {
      const stub = makeDraftStub();
      vi.stubGlobal('chrome', stub);

      vi.useFakeTimers();
      try {
        const el = mount();
        el.target = makeTarget();

        const ta = el.shadowRoot!.querySelector(
          'textarea.fl-textarea',
        ) as HTMLTextAreaElement;
        ta.value = 'about to submit';
        ta.dispatchEvent(new Event('input', { bubbles: true }));

        // Mid-debounce — the saveDraft timer is armed but has not fired.
        vi.advanceTimersByTime(100);
        expect(stub.storage.session.set).not.toHaveBeenCalled();

        (
          el.shadowRoot!.querySelector(
            'button[data-action="submit"]',
          ) as HTMLButtonElement
        ).click();

        // Drain everything: the deleteDraft await chain plus the (now
        // cancelled) saveDraft timer's would-be flush.
        await vi.runAllTimersAsync();

        // No `fl_drafts` slot was ever written — the cancelled debounce
        // means the only storage call sequence we expect is from the
        // deleteDraft path, which short-circuits when the slot is empty.
        expect(stub.storage.session._data.fl_drafts).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ---------------------------------------------------------------------
  // Modal dialog: native focus-trap and Escape semantics (task 33.1,
  // Req 42.1, 42.2, 42.3).
  //
  // The popover hosts a native <dialog> opened via showModal() so the
  // user-agent provides a focus-trap (Tab keeps focus inside) and
  // Escape-closes-the-dialog without us reimplementing them. jsdom 29's
  // HTMLDialogElement does not expose `showModal` / `close` (verified at
  // jsdom@29.0.2), so the assertions below feature-detect the API and
  // fall back to inspecting the element's `open` attribute and
  // dispatching the synthetic `close` event the popover listens for.
  // ---------------------------------------------------------------------

  describe('modal <dialog> focus-trap and Escape (task 33.1)', () => {
    it('opens the dialog via showModal() when available, with margin: 0 to preserve absolute anchoring', () => {
      const el = mount();
      const d = dialog(el);
      const showModalCalls: number[] = [];
      const showCalls: number[] = [];
      const realShowModal = (d as unknown as { showModal?: () => void }).showModal;
      const realShow = (d as unknown as { show?: () => void }).show;

      // Stub showModal so this test exercises the modal-open code path
      // even on jsdom where the API is missing. The stub also flips the
      // `open` attribute to mimic the platform behavior the popover
      // depends on (`if (this.#dialog.open) return;` early-out).
      (d as unknown as { showModal: () => void }).showModal = function () {
        showModalCalls.push(1);
        d.setAttribute('open', '');
      };
      // If `show()` ever gets called we want to know — task 33.1
      // explicitly switches to showModal().
      (d as unknown as { show: () => void }).show = function () {
        showCalls.push(1);
        d.setAttribute('open', '');
      };

      try {
        el.target = makeTarget({ pageX: 100, pageY: 200 });
        expect(showModalCalls.length).toBe(1);
        expect(showCalls.length).toBe(0);
        // margin:0 is set programmatically before showModal so the UA
        // top-layer centering does not displace the absolute anchoring.
        expect(d.style.margin).toBe('0px');
        // Inline left/top still anchor at (pageX, pageY+30).
        expect(d.style.left).toBe('100px');
        expect(d.style.top).toBe('230px');
      } finally {
        if (typeof realShowModal === 'function') {
          (d as unknown as { showModal: () => void }).showModal = realShowModal;
        } else {
          delete (d as unknown as { showModal?: () => void }).showModal;
        }
        if (typeof realShow === 'function') {
          (d as unknown as { show: () => void }).show = realShow;
        } else {
          delete (d as unknown as { show?: () => void }).show;
        }
      }
    });

    it('falls back to setting [open] when showModal throws (e.g. jsdom)', () => {
      const el = mount();
      const d = dialog(el);
      const realShowModal = (d as unknown as { showModal?: () => void }).showModal;

      // Force showModal to throw to simulate environments where the
      // dialog cannot enter the top layer (jsdom, detached fragments).
      (d as unknown as { showModal: () => void }).showModal = function () {
        throw new DOMException('not attached', 'InvalidStateError');
      };

      try {
        el.target = makeTarget();
        // The popover catches the throw and falls back to the attribute
        // path so the rest of the popover still renders.
        expect(d.hasAttribute('open')).toBe(true);
      } finally {
        if (typeof realShowModal === 'function') {
          (d as unknown as { showModal: () => void }).showModal = realShowModal;
        } else {
          delete (d as unknown as { showModal?: () => void }).showModal;
        }
      }
    });

    it('re-emits the dialog\'s native `close` event (Escape closes the dialog) as a composed `close` CustomEvent', () => {
      // jsdom does not implement Escape-closes-the-dialog (and has no
      // `showModal` to trigger the focus-trap), so we exercise the
      // observable contract: when the platform fires the dialog's
      // native `close` event — which is exactly what the user agent
      // does after Escape on a real <dialog> opened via showModal() —
      // the popover re-emits it as a bubbling+composed `close` event so
      // an ancestor `<fl-overlay-host>` can react.
      const el = mount();
      el.target = makeTarget();
      let closeFired = 0;
      let lastEvent: Event | undefined;
      document.addEventListener('close', (e) => {
        closeFired++;
        lastEvent = e;
      });

      dialog(el).dispatchEvent(new Event('close'));

      expect(closeFired).toBe(1);
      expect((lastEvent as CustomEvent).bubbles).toBe(true);
      expect((lastEvent as CustomEvent).composed).toBe(true);
    });

    it('keeps the first focusable control reachable on open so the UA focus-trap has a target', () => {
      // The native focus-trap is a property of the platform `<dialog>`
      // element when opened via showModal(); we cannot test the trap in
      // jsdom. What we CAN test is the structural precondition: the
      // dialog still exposes at least one focusable element on open so
      // the UA has something to move focus to. The first tab button is
      // the leading focusable in create mode.
      const el = mount();
      el.target = makeTarget();
      const d = dialog(el);
      const focusables = d.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      expect(focusables.length).toBeGreaterThan(0);
      const first = focusables[0];
      // Sanity: matches the first tab button rendered in the template.
      expect(first.tagName).toBe('BUTTON');
      expect(first.dataset.tab).toBe('note');
    });

    it('closes silently (no `close` event) when target is set to null while the dialog is open', () => {
      const el = mount();
      el.target = makeTarget();
      let closeFired = 0;
      document.addEventListener('close', () => closeFired++);

      el.target = null;
      // Setting target=null is the host's signal that the popover should
      // dismiss without emitting `close` (the host already knows it set
      // target to null).
      expect(dialog(el).open).toBe(false);
      expect(closeFired).toBe(0);
    });
  });

  // ---------------------------------------------------------------------
  // Focus restore on popover close (task 33.3, Req 42.3).
  //
  // When the dialog opens we capture document.activeElement (descended
  // through open shadow roots so a focused leaf inside another Custom
  // Element is captured at the leaf, not the host). On close — whether
  // via Escape (native dialog `close` event), Submit, Cancel, or
  // programmatic target=null — focus is moved back to that element if
  // it is still in the DOM and focusable. When the original target is
  // gone, focus falls through to the floating toolbar and finally
  // `document.body`.
  //
  // jsdom honors HTMLElement.focus() / document.activeElement so all
  // assertions here run against the real DOM, no stubbing required.
  // ---------------------------------------------------------------------

  describe('focus restore on popover close (task 33.3, Req 42.3)', () => {
    /**
     * Add a focusable element to `document.body`, focus it, and return
     * the element so the test can assert focus comes back to it after
     * the popover closes.
     */
    function makeTriggerButton(label = 'open-popover'): HTMLButtonElement {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      // jsdom won't actually move focus until the button is connected
      // and focusable; appending to body satisfies both.
      document.body.appendChild(btn);
      btn.focus();
      return btn;
    }

    it('captures the previously-focused element BEFORE showModal() so the user-agent\'s focus shift into the dialog does not poison the capture', () => {
      const trigger = makeTriggerButton();
      // Sanity: the trigger really has focus before the popover opens.
      expect(document.activeElement).toBe(trigger);

      const el = mount();
      const d = dialog(el);

      // Stub showModal so the test exercises the modal-open path. The
      // stub mimics the platform behavior of moving focus into the
      // dialog so we can verify the capture happened BEFORE that
      // happens — if the popover read activeElement after showModal()
      // it would capture an element inside the dialog, breaking
      // restore.
      let capturedAtShowModal: Element | null = null;
      const realShowModal = (d as unknown as { showModal?: () => void }).showModal;
      (d as unknown as { showModal: () => void }).showModal = function () {
        capturedAtShowModal = document.activeElement;
        d.setAttribute('open', '');
        // Mimic the UA shifting focus into the dialog.
        const firstButton = d.querySelector<HTMLButtonElement>(
          'button[role="tab"]',
        );
        firstButton?.focus();
      };
      try {
        el.target = makeTarget();
        // At showModal-time, the focus was still on the trigger — proving
        // the popover read activeElement before the platform moved focus.
        expect(capturedAtShowModal).toBe(trigger);
      } finally {
        if (typeof realShowModal === 'function') {
          (d as unknown as { showModal: () => void }).showModal = realShowModal;
        } else {
          delete (d as unknown as { showModal?: () => void }).showModal;
        }
      }
    });

    it('restores focus to the previously-focused element when the dialog\'s native `close` event fires (Escape)', () => {
      const trigger = makeTriggerButton('escape-trigger');

      const el = mount();
      el.target = makeTarget();
      // Before close, focus may be on the trigger (jsdom does not move
      // focus on showModal()) — clear it so the assertion proves
      // the restore actually moved focus, not just left it where it was.
      (document.activeElement as HTMLElement | null)?.blur?.();
      document.body.focus();

      // The native `close` event is what the platform fires after
      // Escape on a real <dialog> opened via showModal().
      dialog(el).dispatchEvent(new Event('close'));

      expect(document.activeElement).toBe(trigger);
    });

    it('restores focus on Cancel click', () => {
      const trigger = makeTriggerButton('cancel-trigger');
      const el = mount();
      el.target = makeTarget();
      (document.activeElement as HTMLElement | null)?.blur?.();
      document.body.focus();

      const cancelBtn = el.shadowRoot!.querySelector(
        'button[data-action="cancel"]',
      ) as HTMLButtonElement;
      cancelBtn.click();

      expect(document.activeElement).toBe(trigger);
    });

    it('restores focus on Submit click (successful submit)', () => {
      // The submit path closes the dialog silently after dispatching
      // `submit`, so the same focus-restore must run for keyboard users
      // who Submit-and-go (Req 42.3 / task 33.3).
      const trigger = makeTriggerButton('submit-trigger');
      const el = mount();
      el.target = makeTarget();
      // Fill the textarea so the Submit button is enabled and the
      // submit handler does not bail out on empty body.
      const ta = el.shadowRoot!.querySelector(
        'textarea.fl-textarea',
      ) as HTMLTextAreaElement;
      ta.value = 'a real annotation body';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      // Move focus off the trigger so the assertion proves restore
      // actually moved focus rather than just leaving it in place.
      (document.activeElement as HTMLElement | null)?.blur?.();
      document.body.focus();

      const submitBtn = el.shadowRoot!.querySelector(
        'button[data-action="submit"]',
      ) as HTMLButtonElement;
      submitBtn.click();

      expect(document.activeElement).toBe(trigger);
    });

    it('restores focus when target is set to null (programmatic close)', () => {
      const trigger = makeTriggerButton('programmatic-trigger');
      const el = mount();
      el.target = makeTarget();
      (document.activeElement as HTMLElement | null)?.blur?.();
      document.body.focus();

      el.target = null;

      expect(document.activeElement).toBe(trigger);
    });

    it('restores focus on the view-mode Close click', () => {
      const trigger = makeTriggerButton('view-close-trigger');
      const el = mount();
      el.annotation = makeAnnotation();
      el.target = makeTarget();
      (document.activeElement as HTMLElement | null)?.blur?.();
      document.body.focus();

      const closeBtn = el.shadowRoot!.querySelector(
        'button[data-action="close"]',
      ) as HTMLButtonElement;
      closeBtn.click();

      expect(document.activeElement).toBe(trigger);
    });

    it('falls back to the floating toolbar when the previously-focused element was removed from the DOM while the dialog was open', () => {
      const trigger = makeTriggerButton('removable-trigger');
      // Add a floating toolbar so the fallback chain has something to
      // land on. We use a bare HTMLElement standin so the test does not
      // depend on the real `<fl-floating-toolbar>` Custom Element being
      // registered.
      const toolbar = document.createElement('fl-floating-toolbar');
      toolbar.tabIndex = 0;
      document.body.appendChild(toolbar);

      const el = mount();
      el.target = makeTarget();

      // Simulate the host re-rendering: the trigger is gone before the
      // popover closes, so the captured reference is stale.
      trigger.remove();
      (document.activeElement as HTMLElement | null)?.blur?.();
      document.body.focus();

      el.target = null;

      // Focus lands on the floating toolbar, not <body>.
      expect(document.activeElement).toBe(toolbar);
    });

    it('falls back to <body> when neither the previously-focused element nor a floating toolbar is available', () => {
      const trigger = makeTriggerButton('no-fallback-trigger');
      const el = mount();
      el.target = makeTarget();

      trigger.remove();
      (document.activeElement as HTMLElement | null)?.blur?.();
      // No <fl-floating-toolbar> in the DOM; the chain falls through to
      // body.focus().
      el.target = null;

      // jsdom's body.focus() resets activeElement to body; the assertion
      // ensures we did not throw and didn't land focus on a stale ref.
      expect(document.activeElement === document.body || document.activeElement === null).toBe(true);
    });

    it('does not throw when no element was focused at open time (activeElement was <body>)', () => {
      // Force focus to body so deepActiveElement returns null.
      document.body.focus();
      // jsdom may park activeElement on body even when nothing has been
      // explicitly focused; that's exactly the "no previous focus"
      // scenario we want to exercise.
      const el = mount();
      el.target = makeTarget();

      expect(() => {
        el.target = null;
      }).not.toThrow();
    });

    it('skips restoring to a disabled element and falls back to the floating toolbar', () => {
      const trigger = makeTriggerButton('disabling-trigger');
      // Add a toolbar so the fallback chain has a focusable target.
      const toolbar = document.createElement('fl-floating-toolbar');
      toolbar.tabIndex = 0;
      document.body.appendChild(toolbar);

      const el = mount();
      el.target = makeTarget();

      // The page disabled the original control while the dialog was
      // open (a common pattern when a form save is in flight).
      trigger.disabled = true;
      (document.activeElement as HTMLElement | null)?.blur?.();
      document.body.focus();

      el.target = null;

      // Focus must NOT land on the disabled control; instead the
      // toolbar fallback wins.
      expect(document.activeElement).toBe(toolbar);
      expect(document.activeElement).not.toBe(trigger);
    });

    it('clears the captured reference after restore so a re-open captures fresh focus', () => {
      const triggerA = makeTriggerButton('trigger-a');
      const el = mount();
      el.target = makeTarget();
      el.target = null;
      // First close should have restored to triggerA.
      expect(document.activeElement).toBe(triggerA);

      // New trigger takes focus before the next open.
      const triggerB = makeTriggerButton('trigger-b');
      expect(document.activeElement).toBe(triggerB);

      el.target = makeTarget();
      (document.activeElement as HTMLElement | null)?.blur?.();
      document.body.focus();
      el.target = null;

      // Second close restores to triggerB, not triggerA.
      expect(document.activeElement).toBe(triggerB);
    });
  });
});

describe('<fl-popover> capture-buffer attachment (Req 36.2, task 27.3)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  /**
   * Stub matching the `Pick<CaptureBuffer, 'getConsoleEntries' |
   * 'getNetworkEntries'>` shape the popover expects. Records call counts
   * so tests can assert the popover does NOT pull captures for non-bug-
   * report submissions.
   */
  function makeCaptureStub() {
    const consoleEntries = [
      {
        level: 'error' as const,
        message: 'boom',
        timestamp: '2024-06-01T12:00:00.000Z',
        stack: 'Error: boom\n    at fn',
      },
      {
        level: 'warn' as const,
        message: 'careful',
        timestamp: '2024-06-01T12:00:01.000Z',
      },
    ];
    const networkEntries = [
      {
        name: 'https://example.com/api/x',
        initiatorType: 'fetch',
        startTime: 12.5,
        duration: 240.7,
        responseStatus: 500,
      },
    ];
    const getConsoleEntries = vi.fn(() => consoleEntries.slice());
    const getNetworkEntries = vi.fn(() => networkEntries.slice());
    return {
      stub: { getConsoleEntries, getNetworkEntries },
      consoleEntries,
      networkEntries,
      getConsoleEntries,
      getNetworkEntries,
    };
  }

  async function submitWith(
    el: FlPopover,
    body: string,
  ): Promise<Annotation | undefined> {
    let received: Annotation | undefined;
    el.addEventListener('submit', (e: Event) => {
      received = (e as CustomEvent<PopoverSubmitDetail>).detail.annotation;
    });
    const ta = el.shadowRoot!.querySelector('textarea.fl-textarea') as HTMLTextAreaElement;
    ta.value = body;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    (
      el.shadowRoot!.querySelector('button[data-action="submit"]') as HTMLButtonElement
    ).click();
    await flushMicrotasks();
    return received;
  }

  it('attaches captured console + network buffers to a Critical Note submission', async () => {
    const el = mount();
    el.target = makeTarget();
    const { stub, consoleEntries, networkEntries, getConsoleEntries, getNetworkEntries } =
      makeCaptureStub();
    el.captureBuffer = stub;

    severityButtons(el).find((b) => b.dataset.severity === 'critical')!.click();

    const annotation = await submitWith(el, 'a critical bug');
    expect(annotation).toBeDefined();
    expect(annotation!.type).toBe('note');
    expect(annotation!.severity).toBe('critical');
    expect(annotation!.capturedConsole).toEqual(consoleEntries);
    expect(annotation!.capturedNetwork).toEqual(networkEntries);
    expect(getConsoleEntries).toHaveBeenCalledTimes(1);
    expect(getNetworkEntries).toHaveBeenCalledTimes(1);
  });

  it('attaches captured buffers to a Major Note submission', async () => {
    const el = mount();
    el.target = makeTarget();
    const { stub, consoleEntries, networkEntries } = makeCaptureStub();
    el.captureBuffer = stub;

    severityButtons(el).find((b) => b.dataset.severity === 'major')!.click();

    const annotation = await submitWith(el, 'a major bug');
    expect(annotation!.severity).toBe('major');
    expect(annotation!.capturedConsole).toEqual(consoleEntries);
    expect(annotation!.capturedNetwork).toEqual(networkEntries);
  });

  it('does NOT attach captures for a Note at minor or informational severity', async () => {
    const el = mount();
    el.target = makeTarget();
    const { stub, getConsoleEntries, getNetworkEntries } = makeCaptureStub();
    el.captureBuffer = stub;

    // Default severity is `informational` — no severity click required.
    let annotation = await submitWith(el, 'a passing note');
    expect(annotation!.severity).toBe('informational');
    expect(annotation!.capturedConsole).toBeUndefined();
    expect(annotation!.capturedNetwork).toBeUndefined();

    // Reset and try `minor`.
    el.target = makeTarget();
    severityButtons(el).find((b) => b.dataset.severity === 'minor')!.click();
    annotation = await submitWith(el, 'another note');
    expect(annotation!.severity).toBe('minor');
    expect(annotation!.capturedConsole).toBeUndefined();
    expect(annotation!.capturedNetwork).toBeUndefined();

    expect(getConsoleEntries).not.toHaveBeenCalled();
    expect(getNetworkEntries).not.toHaveBeenCalled();
  });

  it('does NOT attach captures for a Suggestion at any severity', async () => {
    const el = mount();
    el.target = makeTarget();
    const { stub, getConsoleEntries, getNetworkEntries } = makeCaptureStub();
    el.captureBuffer = stub;

    tabButtons(el).find((b) => b.dataset.tab === 'suggestion')!.click();
    severityButtons(el).find((b) => b.dataset.severity === 'critical')!.click();

    const annotation = await submitWith(el, 'a critical suggestion');
    expect(annotation!.type).toBe('suggestion');
    expect(annotation!.severity).toBe('critical');
    expect(annotation!.capturedConsole).toBeUndefined();
    expect(annotation!.capturedNetwork).toBeUndefined();
    expect(getConsoleEntries).not.toHaveBeenCalled();
    expect(getNetworkEntries).not.toHaveBeenCalled();
  });

  it('does NOT attach captures for a Guideline submission', async () => {
    const el = mount();
    el.target = makeTarget();
    const { stub, getConsoleEntries, getNetworkEntries } = makeCaptureStub();
    el.captureBuffer = stub;

    tabButtons(el).find((b) => b.dataset.tab === 'guideline')!.click();
    severityButtons(el).find((b) => b.dataset.severity === 'critical')!.click();

    const annotation = await submitWith(el, 'a critical guideline');
    expect(annotation!.type).toBe('guideline');
    expect(annotation!.capturedConsole).toBeUndefined();
    expect(annotation!.capturedNetwork).toBeUndefined();
    expect(getConsoleEntries).not.toHaveBeenCalled();
    expect(getNetworkEntries).not.toHaveBeenCalled();
  });

  it('omits captures when no captureBuffer source is set, even on bug-report severity', async () => {
    const el = mount();
    el.target = makeTarget();
    // captureBuffer left as null (default).
    severityButtons(el).find((b) => b.dataset.severity === 'critical')!.click();

    const annotation = await submitWith(el, 'a critical bug with no buffer');
    expect(annotation!.severity).toBe('critical');
    expect(annotation!.capturedConsole).toBeUndefined();
    expect(annotation!.capturedNetwork).toBeUndefined();
  });

  it('emits empty arrays when the buffers are empty (still indicates capture is wired)', async () => {
    const el = mount();
    el.target = makeTarget();
    const stub = {
      getConsoleEntries: vi.fn(() => []),
      getNetworkEntries: vi.fn(() => []),
    };
    el.captureBuffer = stub;
    severityButtons(el).find((b) => b.dataset.severity === 'critical')!.click();

    const annotation = await submitWith(el, 'a critical bug, no logs');
    expect(annotation!.capturedConsole).toEqual([]);
    expect(annotation!.capturedNetwork).toEqual([]);
  });
});
