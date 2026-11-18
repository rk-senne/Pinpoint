/**
 * OnboardingWizard — Mission B3 (onboarding: copy-paste snippet + live
 * install verification). A short, intuitive stepper that takes a new user
 * from "I have an account" to "feedback is flowing" in four steps:
 *
 *   Step 1 — Pick a project. List existing projects (GET /projects, now
 *            `{ data, pagination }`) or create one inline.
 *   Step 2 — Issue a project-bound widget key (POST /api-keys,
 *            keyType 'widget') with an optional comma-separated
 *            allowed-origins list. The raw `pk_widget_…` key is shown once.
 *   Step 3 — Show the exact embed snippet with an explicit, editable
 *            `apiUrl` (never silently guessed), a Copy button, and tabs for
 *            the browser extension and review-link reach mechanisms.
 *   Step 4 — Verify install: poll GET /projects/:id/annotations every 3s for
 *            up to 2 minutes until an annotation newer than the verification
 *            start appears. Success / timeout / cancel states.
 *
 * Accessibility: every input is labelled, there is a single
 * `aria-live="polite"` status region, focus moves to each step heading on
 * step change, all buttons are real `<button>`s, and the step indicator uses
 * `aria-current="step"`. All dynamic text is written via `el()`/`setText`
 * from `@pinpoint/shared` — no `innerHTML` for dynamic data. Colours come
 * from the `BRAND_COLORS` tokens (as CSS-custom-property fallbacks).
 *
 * Exposed as `mountOnboardingWizard(container)` returning a teardown fn
 * (unchanged signature). Persists completion in localStorage.
 */

import { navigate } from '../lib/router';
import { apiFetch } from '../lib/api';
import { el, setText, BRAND_COLORS } from '@pinpoint/shared';

const ONBOARDING_COMPLETE_KEY = 'pinpoint_onboarding_complete';

/** 3s poll cadence, 2min ceiling for the install-verification step. */
export const VERIFY_POLL_INTERVAL_MS = 3_000;
export const VERIFY_TIMEOUT_MS = 2 * 60 * 1000;

const PRIMARY = `var(--color-primary,${BRAND_COLORS.primary})`;
const INPUT_CSS =
  'display:block;width:100%;box-sizing:border-box;padding:8px 12px;margin-top:4px;border:1px solid #d1d5db;border-radius:6px;font:inherit;';
const PRIMARY_BTN_CSS = `padding:8px 20px;background:${PRIMARY};color:#fff;border:none;border-radius:6px;cursor:pointer;font:inherit;`;
const GHOST_BTN_CSS =
  'padding:8px 20px;background:none;border:1px solid #d1d5db;border-radius:6px;cursor:pointer;font:inherit;';

interface ProjectSummary {
  id: string;
  name: string;
}

interface WidgetKeyResponse {
  rawKey: string;
  id: string;
}

interface AnnotationRow {
  id: string;
  createdAt?: string;
  created_at?: string;
}

interface WizardState {
  step: number;
  projects: ProjectSummary[];
  selectedProjectId: string | null;
  widgetKey: string | null;
  apiUrl: string;
}

const STEP_TITLES = [
  'Choose a project',
  'Create a widget key',
  'Add the snippet to your site',
  'Verify your install',
];

type Fetcher = typeof apiFetch;

export function mountOnboardingWizard(container: HTMLElement): () => void {
  if (localStorage.getItem(ONBOARDING_COMPLETE_KEY) === 'true') {
    navigate('/');
    return () => {};
  }

  // A seam so tests can inject a fake fetcher without stubbing globals; the
  // default is the real apiFetch. Attached to the container dataset-free via
  // a module closure variable.
  const fetcher: Fetcher = (container as { __onboardingFetcher?: Fetcher }).__onboardingFetcher ?? apiFetch;

  const state: WizardState = {
    step: 0,
    projects: [],
    selectedProjectId: null,
    widgetKey: null,
    apiUrl: window.location.origin,
  };

  // Teardown registry for the active step (poll timers etc.).
  let stepCleanup: (() => void) | null = null;
  function runStepCleanup(): void {
    if (stepCleanup) {
      stepCleanup();
      stepCleanup = null;
    }
  }

  function setStatus(statusEl: HTMLElement, message: string): void {
    setText(statusEl, message);
  }

  function render(): void {
    runStepCleanup();
    container.replaceChildren();

    const wizard = el('div', { class: 'onboarding-wizard' });
    wizard.style.cssText = 'max-width:560px;margin:64px auto;padding:32px;';

    // --- step indicator (aria-current='step') -------------------------
    const indicator = el('ol', { class: 'onboarding-steps', 'aria-label': 'Setup steps' });
    indicator.style.cssText =
      'display:flex;gap:8px;list-style:none;padding:0;margin:0 0 28px;justify-content:center;';
    STEP_TITLES.forEach((title, i) => {
      const li = el('li', i === state.step ? { 'aria-current': 'step' } : {});
      li.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:4px;flex:1;';
      const dot = el('span', { 'aria-hidden': 'true' });
      dot.style.cssText = `width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;background:${
        i <= state.step ? PRIMARY : '#d1d5db'
      };`;
      setText(dot, String(i + 1));
      const label = el('span');
      label.style.cssText = `font-size:0.75rem;text-align:center;color:${
        i === state.step ? 'var(--pp-text-primary)' : 'var(--pp-text-secondary)'
      };`;
      setText(label, title);
      li.append(dot, label);
      indicator.appendChild(li);
    });
    wizard.appendChild(indicator);

    // --- step heading (focus target) ----------------------------------
    const heading = el('h1', { id: 'onboarding-step-heading', tabindex: '-1' });
    heading.style.cssText = 'font-size:1.5rem;margin:0 0 8px;outline:none;';
    setText(heading, STEP_TITLES[state.step]!);
    wizard.appendChild(heading);

    // --- aria-live status region --------------------------------------
    const status = el('p', {
      class: 'onboarding-status',
      role: 'status',
      'aria-live': 'polite',
    });
    status.style.cssText = 'min-height:1.25rem;color:#6b7280;margin:0 0 20px;';
    wizard.appendChild(status);

    // --- per-step body ------------------------------------------------
    const body = el('div', { class: 'onboarding-body' });
    wizard.appendChild(body);

    switch (state.step) {
      case 0:
        renderStepProject(body, status);
        break;
      case 1:
        renderStepKey(body, status);
        break;
      case 2:
        renderStepSnippet(body, status);
        break;
      case 3:
        renderStepVerify(body, status);
        break;
    }

    // --- skip link ----------------------------------------------------
    const skip = el('button', { type: 'button', class: 'onboarding-skip' }, 'Skip setup');
    skip.style.cssText =
      'margin-top:24px;background:none;border:none;color:var(--pp-text-secondary);cursor:pointer;font-size:0.875rem;';
    skip.addEventListener('click', complete);
    wizard.appendChild(skip);

    container.appendChild(wizard);

    // Move focus to the step heading on each render (step change).
    heading.focus();
  }

  function complete(): void {
    localStorage.setItem(ONBOARDING_COMPLETE_KEY, 'true');
    navigate('/');
  }

  /* ---------------------------- Step 1 ---------------------------- */
  function renderStepProject(body: HTMLElement, status: HTMLElement): void {
    setStatus(status, 'Loading your projects…');

    const existing = el('fieldset', { class: 'onboarding-existing' });
    existing.style.cssText = 'border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin-bottom:16px;';
    const legend = el('legend');
    setText(legend, 'Pick an existing project');
    existing.appendChild(legend);

    const selectLabel = el('label', { for: 'onboarding-project-select' });
    setText(selectLabel, 'Project');
    const select = el('select', { id: 'onboarding-project-select', class: 'onboarding-project-select' });
    select.style.cssText = INPUT_CSS;
    existing.append(selectLabel, select);

    const useExistingBtn = el('button', { type: 'button', class: 'onboarding-use-existing' }, 'Use this project');
    useExistingBtn.style.cssText = PRIMARY_BTN_CSS + 'margin-top:12px;';
    useExistingBtn.disabled = true;
    existing.appendChild(useExistingBtn);

    body.appendChild(existing);

    // --- create new ---
    const createFs = el('fieldset', { class: 'onboarding-create' });
    createFs.style.cssText = 'border:1px solid #e5e7eb;border-radius:8px;padding:16px;';
    const createLegend = el('legend');
    setText(createLegend, 'Or create a new project');
    createFs.appendChild(createLegend);

    const nameLabel = el('label', { for: 'onboarding-project-name' });
    setText(nameLabel, 'Project name');
    const nameInput = el('input', {
      id: 'onboarding-project-name',
      type: 'text',
      placeholder: 'My website',
    });
    nameInput.style.cssText = INPUT_CSS;

    const urlLabel = el('label', { for: 'onboarding-project-url' });
    setText(urlLabel, 'Website URL');
    urlLabel.style.cssText = 'display:block;margin-top:12px;';
    const urlInput = el('input', {
      id: 'onboarding-project-url',
      type: 'url',
      placeholder: 'https://example.com',
    });
    urlInput.style.cssText = INPUT_CSS;

    const createBtn = el('button', { type: 'button', class: 'onboarding-create-project' }, 'Create project');
    createBtn.style.cssText = PRIMARY_BTN_CSS + 'margin-top:12px;';

    createFs.append(nameLabel, nameInput, urlLabel, urlInput, createBtn);
    body.appendChild(createFs);

    // Populate the select from GET /projects.
    void (async () => {
      try {
        const resp = await fetcher<{ data: ProjectSummary[] }>('/projects');
        state.projects = resp.data ?? [];
        if (state.projects.length === 0) {
          setStatus(status, 'No projects yet — create your first one below.');
          select.disabled = true;
          const opt = el('option', { value: '' }, 'No projects yet');
          select.appendChild(opt);
        } else {
          setStatus(status, 'Pick a project to attach the widget to, or create a new one.');
          const placeholder = el('option', { value: '' }, 'Select a project…');
          select.appendChild(placeholder);
          for (const p of state.projects) {
            const opt = el('option', { value: p.id });
            setText(opt, p.name);
            select.appendChild(opt);
          }
        }
      } catch {
        setStatus(status, 'Could not load projects. You can still create a new one below.');
      }
    })();

    select.addEventListener('change', () => {
      useExistingBtn.disabled = !(select as HTMLSelectElement).value;
    });

    useExistingBtn.addEventListener('click', () => {
      const value = (select as HTMLSelectElement).value;
      if (!value) return;
      state.selectedProjectId = value;
      goToStep(1);
    });

    createBtn.addEventListener('click', async () => {
      const name = (nameInput as HTMLInputElement).value.trim();
      const url = (urlInput as HTMLInputElement).value.trim();
      if (!name || !url) {
        setStatus(status, 'Enter both a project name and a website URL.');
        return;
      }
      createBtn.disabled = true;
      setStatus(status, 'Creating project…');
      try {
        const created = await fetcher<ProjectSummary>('/projects', {
          method: 'POST',
          body: JSON.stringify({ name, urls: [url] }),
        });
        state.selectedProjectId = created.id;
        goToStep(1);
      } catch {
        createBtn.disabled = false;
        setStatus(status, 'Could not create the project. Check the details and try again.');
      }
    });
  }

  /* ---------------------------- Step 2 ---------------------------- */
  function renderStepKey(body: HTMLElement, status: HTMLElement): void {
    setStatus(status, 'Issue a widget key for this project. The key is shown once.');

    const form = el('div', { class: 'onboarding-key-form' });

    const nameLabel = el('label', { for: 'onboarding-key-name' });
    setText(nameLabel, 'Key name');
    const nameInput = el('input', {
      id: 'onboarding-key-name',
      type: 'text',
      value: 'Website widget',
    });
    nameInput.style.cssText = INPUT_CSS;

    const originsLabel = el('label', { for: 'onboarding-key-origins' });
    setText(originsLabel, 'Allowed origins (optional, comma-separated)');
    originsLabel.style.cssText = 'display:block;margin-top:12px;';
    const originsInput = el('input', {
      id: 'onboarding-key-origins',
      type: 'text',
      placeholder: 'https://example.com, https://www.example.com',
    });
    originsInput.style.cssText = INPUT_CSS;

    const hint = el('p');
    hint.style.cssText = 'color:var(--pp-text-secondary);font-size:0.8125rem;margin:6px 0 0;';
    setText(hint, 'Leave origins blank to allow submissions from any site during setup.');

    const issueBtn = el('button', { type: 'button', class: 'onboarding-issue-key' }, 'Issue widget key');
    issueBtn.style.cssText = PRIMARY_BTN_CSS + 'margin-top:16px;';

    const backBtn = el('button', { type: 'button', class: 'onboarding-back' }, 'Back');
    backBtn.style.cssText = GHOST_BTN_CSS + 'margin-top:16px;margin-left:8px;';
    backBtn.addEventListener('click', () => goToStep(0));

    form.append(nameLabel, nameInput, originsLabel, originsInput, hint, issueBtn, backBtn);
    body.appendChild(form);

    issueBtn.addEventListener('click', async () => {
      if (!state.selectedProjectId) {
        setStatus(status, 'No project selected — go back and pick one.');
        return;
      }
      const name = (nameInput as HTMLInputElement).value.trim() || 'Website widget';
      const originsRaw = (originsInput as HTMLInputElement).value.trim();
      const allowedOrigins = originsRaw
        ? originsRaw.split(',').map((o) => o.trim()).filter(Boolean)
        : undefined;

      const requestBody: Record<string, unknown> = {
        name,
        keyType: 'widget',
        projectId: state.selectedProjectId,
      };
      if (allowedOrigins && allowedOrigins.length > 0) {
        requestBody.allowedOrigins = allowedOrigins;
      }

      issueBtn.disabled = true;
      setStatus(status, 'Issuing key…');
      try {
        const resp = await fetcher<WidgetKeyResponse>('/api-keys', {
          method: 'POST',
          body: JSON.stringify(requestBody),
        });
        state.widgetKey = resp.rawKey;
        goToStep(2);
      } catch {
        issueBtn.disabled = false;
        setStatus(status, 'Could not issue the key. Please try again.');
      }
    });
  }

  /* ---------------------------- Step 3 ---------------------------- */
  function renderStepSnippet(body: HTMLElement, status: HTMLElement): void {
    setStatus(status, 'Copy this snippet into your site, just before </body>.');

    // Editable, explicit apiUrl — never silently guessed.
    const apiLabel = el('label', { for: 'onboarding-api-url' });
    setText(apiLabel, 'API URL');
    const apiInput = el('input', {
      id: 'onboarding-api-url',
      type: 'url',
      value: state.apiUrl,
    });
    apiInput.style.cssText = INPUT_CSS;

    const snippetLabel = el('label', { for: 'onboarding-snippet' });
    setText(snippetLabel, 'Embed snippet');
    snippetLabel.style.cssText = 'display:block;margin-top:16px;';
    const snippet = el('textarea', {
      id: 'onboarding-snippet',
      class: 'onboarding-snippet',
      readonly: true,
    }) as HTMLTextAreaElement;
    snippet.rows = 3;
    snippet.style.cssText =
      'display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:12px;border:1px solid #d1d5db;border-radius:6px;font-family:monospace;font-size:0.8125rem;white-space:pre;';

    const buildSnippet = (): string => {
      const key = state.widgetKey ?? '';
      const api = (apiInput as HTMLInputElement).value.trim() || state.apiUrl;
      return (
        `<script src="${api}/widget/pinpoint-widget.js"></script>\n` +
        `<script>Pinpoint.init({ projectKey: '${key}', apiUrl: '${api}' });</script>`
      );
    };
    // textarea.value assignment is NOT innerHTML — the browser treats it as text.
    snippet.value = buildSnippet();
    apiInput.addEventListener('input', () => {
      state.apiUrl = (apiInput as HTMLInputElement).value;
      snippet.value = buildSnippet();
    });

    const copyBtn = el('button', { type: 'button', class: 'onboarding-copy' }, 'Copy snippet');
    copyBtn.style.cssText = PRIMARY_BTN_CSS + 'margin-top:12px;';
    const copyStatus = el('span', {
      class: 'onboarding-copy-status',
      role: 'status',
      'aria-live': 'polite',
    });
    copyStatus.style.cssText = 'margin-left:12px;color:#059669;font-size:0.875rem;';

    copyBtn.addEventListener('click', async () => {
      const text = snippet.value;
      const ok = await copyToClipboard(text, snippet);
      setText(copyStatus, ok ? 'Copied' : 'Copy failed — select and copy manually.');
    });

    body.append(apiLabel, apiInput, snippetLabel, snippet, copyBtn, copyStatus);

    // --- reach-mechanism tabs ---
    body.appendChild(renderReachTabs());

    // --- nav ---
    const nav = el('div');
    nav.style.cssText = 'margin-top:24px;';
    const backBtn = el('button', { type: 'button', class: 'onboarding-back' }, 'Back');
    backBtn.style.cssText = GHOST_BTN_CSS;
    backBtn.addEventListener('click', () => goToStep(1));
    const nextBtn = el('button', { type: 'button', class: 'onboarding-verify-next' }, 'Verify install');
    nextBtn.style.cssText = PRIMARY_BTN_CSS + 'margin-left:8px;';
    nextBtn.addEventListener('click', () => goToStep(3));
    nav.append(backBtn, nextBtn);
    body.appendChild(nav);
  }

  function renderReachTabs(): HTMLElement {
    const tabs = el('div', { class: 'onboarding-tabs' });
    tabs.style.cssText = 'margin-top:24px;border-top:1px solid #e5e7eb;padding-top:16px;';

    const tablist = el('div', { role: 'tablist', 'aria-label': 'Other ways to collect feedback' });
    tablist.style.cssText = 'display:flex;gap:8px;';

    const panelExt = el('div', { role: 'tabpanel', id: 'onboarding-tabpanel-ext' });
    const extLink = el(
      'a',
      { href: 'https://chromewebstore.google.com/' },
      'Install the Pinpoint browser extension',
    );
    const extText = el('p');
    setText(extText, 'Prefer annotating live pages visually? Install the browser extension:');
    panelExt.append(extText, extLink);

    const panelReview = el('div', { role: 'tabpanel', id: 'onboarding-tabpanel-review', hidden: true });
    const reviewText = el('p');
    setText(
      reviewText,
      'Share a review link (/review/:linkId) — created from the project\u2019s Share dialog — so reviewers can leave feedback on a proxied copy of your page with nothing to install.',
    );
    panelReview.appendChild(reviewText);

    const extTab = el('button', {
      type: 'button',
      role: 'tab',
      id: 'onboarding-tab-ext',
      'aria-current': 'step',
      class: 'onboarding-tab-ext',
    }, 'Browser extension');
    extTab.style.cssText = GHOST_BTN_CSS;
    const reviewTab = el('button', {
      type: 'button',
      role: 'tab',
      id: 'onboarding-tab-review',
      class: 'onboarding-tab-review',
    }, 'Review link');
    reviewTab.style.cssText = GHOST_BTN_CSS;

    extTab.setAttribute('aria-selected', 'true');
    reviewTab.setAttribute('aria-selected', 'false');

    function select(which: 'ext' | 'review'): void {
      const isExt = which === 'ext';
      panelExt.hidden = !isExt;
      panelReview.hidden = isExt;
      extTab.setAttribute('aria-selected', String(isExt));
      reviewTab.setAttribute('aria-selected', String(!isExt));
    }
    extTab.addEventListener('click', () => select('ext'));
    reviewTab.addEventListener('click', () => select('review'));

    tablist.append(extTab, reviewTab);
    tabs.append(tablist, panelExt, panelReview);
    return tabs;
  }

  /* ---------------------------- Step 4 ---------------------------- */
  function renderStepVerify(body: HTMLElement, status: HTMLElement): void {
    if (!state.selectedProjectId) {
      setStatus(status, 'No project selected — go back and pick one.');
      return;
    }
    setStatus(status, 'Waiting for your first piece of feedback… Trigger the widget on your site.');

    const spinner = el('p', { class: 'onboarding-verify-state' });
    spinner.style.cssText = 'font-size:1rem;color:#6b7280;';
    setText(spinner, 'Polling every 3 seconds for up to 2 minutes…');
    body.appendChild(spinner);

    const cancelBtn = el('button', { type: 'button', class: 'onboarding-cancel' }, 'Cancel');
    cancelBtn.style.cssText = GHOST_BTN_CSS + 'margin-top:16px;';
    body.appendChild(cancelBtn);

    const projectId = state.selectedProjectId;
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const stop = (): void => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    // Register teardown so navigation/unmount clears the timer.
    stepCleanup = stop;

    const finishSuccess = (): void => {
      stop();
      setStatus(status, 'Feedback received! Your install is working.');
      setText(spinner, '\u2705 Success — your first feedback arrived.');
      cancelBtn.replaceChildren();
      setText(cancelBtn, 'Finish');
      cancelBtn.className = 'onboarding-finish';
      cancelBtn.style.cssText = PRIMARY_BTN_CSS + 'margin-top:16px;';
    };

    const finishTimeout = (): void => {
      stop();
      setStatus(
        status,
        'No feedback yet. Double-check the snippet is on your page, then try again.',
      );
      setText(spinner, '\u23f1\ufe0f Timed out after 2 minutes.');
      const retry = el('button', { type: 'button', class: 'onboarding-retry' }, 'Try again');
      retry.style.cssText = PRIMARY_BTN_CSS + 'margin-top:16px;margin-right:8px;';
      retry.addEventListener('click', () => goToStep(3));
      spinner.after(retry);
    };

    const poll = async (): Promise<void> => {
      if (stopped) return;
      if (Date.now() - startedAt >= VERIFY_TIMEOUT_MS) {
        finishTimeout();
        return;
      }
      try {
        const resp = await fetcher<{ data: AnnotationRow[] }>(
          `/projects/${encodeURIComponent(projectId)}/annotations`,
        );
        if (stopped) return;
        const fresh = (resp.data ?? []).some((a) => {
          const ts = Date.parse(a.createdAt ?? a.created_at ?? '');
          return Number.isFinite(ts) && ts >= startedAt;
        });
        if (fresh) {
          finishSuccess();
          return;
        }
      } catch {
        // Transient error — keep polling until the timeout ceiling.
      }
      if (stopped) return;
      timer = setTimeout(() => void poll(), VERIFY_POLL_INTERVAL_MS);
    };

    cancelBtn.addEventListener('click', () => {
      // When success has flipped the button to "Finish", complete; else cancel.
      if (cancelBtn.className === 'onboarding-finish') {
        complete();
        return;
      }
      stop();
      complete();
    });

    // Kick off the first poll on the next tick so fake timers can drive it.
    timer = setTimeout(() => void poll(), VERIFY_POLL_INTERVAL_MS);
  }

  function goToStep(step: number): void {
    state.step = step;
    render();
  }

  render();

  return () => {
    runStepCleanup();
    container.replaceChildren();
  };
}

/**
 * Copy text to the clipboard with a graceful fallback. Prefers the async
 * Clipboard API; when it is unavailable or rejects, falls back to selecting
 * the source textarea and `document.execCommand('copy')`.
 */
async function copyToClipboard(text: string, sourceEl: HTMLTextAreaElement): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to execCommand
  }
  try {
    sourceEl.focus();
    sourceEl.select();
    return document.execCommand('copy');
  } catch {
    return false;
  }
}

export function isOnboardingComplete(): boolean {
  return localStorage.getItem(ONBOARDING_COMPLETE_KEY) === 'true';
}
