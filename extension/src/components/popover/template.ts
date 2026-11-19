// <fl-popover> dialog template, built once and cloned per instance
// (extracted from Popover.ts).

import type { AnnotationType, Severity } from '@pinpoint/shared';
import { POPOVER_CSS } from './styles';

export const TAB_OPTIONS: ReadonlyArray<{ value: AnnotationType; label: string }> = [
  { value: 'note', label: 'Note' },
  { value: 'suggestion', label: 'Suggestion' },
  { value: 'guideline', label: 'Guideline' },
];

export const SEVERITY_OPTIONS: ReadonlyArray<{
  value: Severity;
  label: string;
  className: string;
}> = [
  { value: 'critical', label: 'Critical', className: 'fl-severity-critical' },
  { value: 'major', label: 'Major', className: 'fl-severity-major' },
  { value: 'minor', label: 'Minor', className: 'fl-severity-minor' },
  { value: 'informational', label: 'Info', className: 'fl-severity-informational' },
];

export const TEMPLATE = (() => {
  const t = document.createElement('template');
  // The dialog is built once and cloned per instance. We render BOTH
  // modes' DOM up-front and toggle visibility via the `hidden` attribute
  // on `.fl-popover-create` / `.fl-popover-view` — avoids re-stamping
  // templates on every state change and keeps the focus-trap target
  // (the `<dialog>`) stable.
  // eslint-disable-next-line no-restricted-syntax -- static <template> markup built from module constants, no user data; parsed inertly
  t.innerHTML = `
    <style>${POPOVER_CSS}</style>
    <dialog class="fl-popover" part="dialog" data-pinpoint="popover">
      <div class="fl-popover-tabs" role="tablist">
        ${TAB_OPTIONS.map(
          (tab) => `<button
              type="button"
              role="tab"
              data-tab="${tab.value}"
              aria-selected="false"
            >${tab.label}</button>`,
        ).join('')}
      </div>

      <section class="fl-popover-create" part="create" hidden>
        <div class="fl-severity-selector" role="radiogroup" aria-label="Severity">
          ${SEVERITY_OPTIONS.map(
            (s) => `<button
                type="button"
                class="fl-severity-btn ${s.className}"
                role="radio"
                data-severity="${s.value}"
                aria-checked="false"
                title="${s.label}"
                aria-label="Severity: ${s.label}"
              ></button>`,
          ).join('')}
        </div>
        <div class="fl-popover-textarea-wrap">
          <textarea
            class="fl-textarea"
            part="textarea"
            placeholder="Add your feedback…"
            aria-label="Annotation body"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="false"
            aria-haspopup="listbox"
          ></textarea>
          <fl-mention-autocomplete part="mention-autocomplete" hidden></fl-mention-autocomplete>
        </div>
        <div
          class="fl-environment-summary"
          part="environment-summary"
          role="note"
          aria-label="Environment that will be attached on submit"
        >
          <span class="fl-environment-summary-label">Will attach:</span>
          <span class="fl-environment-summary-text"></span>
        </div>
        <div
          class="fl-triage-hint"
          part="triage-hint"
          role="status"
          aria-live="polite"
          hidden
        ></div>
        <div class="fl-btn-row">
          <button
            type="button"
            class="fl-btn fl-btn-secondary"
            data-action="cancel"
          >Cancel</button>
          <label class="fl-popover-capture-toggle" part="capture-toggle">
            <input
              type="checkbox"
              class="fl-popover-capture-checkbox"
              data-action="capture-toggle"
              checked
            />
            <span>Attach screenshot</span>
          </label>
          <button
            type="button"
            class="fl-btn fl-btn-primary"
            data-action="submit"
            disabled
          >Submit</button>
        </div>
      </section>

      <section class="fl-popover-view" part="view" hidden>
        <div class="fl-popover-viewers" part="viewers" hidden>
          <span class="fl-popover-viewers-list" aria-label="Co-viewers"></span>
          <span class="fl-popover-viewers-label"></span>
        </div>
        <div class="fl-target-stale-warning" part="target-stale-warning" role="status" hidden>
          Target may have moved
        </div>
        <div class="fl-annotation-summary">
          <strong class="fl-annotation-type"></strong>
          <span class="fl-annotation-severity"></span>
        </div>
        <div class="fl-annotation-body"></div>
        <fl-screenshot-viewer
          class="fl-popover-screenshot"
          part="screenshot"
          hidden
        ></fl-screenshot-viewer>
        <details class="fl-environment-details" hidden>
          <summary>Browser metadata</summary>
          <pre class="fl-environment-pre"></pre>
        </details>
        <details class="fl-capture-details fl-capture-console-details" data-role="console-panel" hidden>
          <summary class="fl-capture-summary">Console (<span class="fl-capture-console-count">0</span>)</summary>
          <ul class="fl-capture-list fl-capture-console-list" data-role="console-list"></ul>
        </details>
        <details class="fl-capture-details fl-capture-network-details" data-role="network-panel" hidden>
          <summary class="fl-capture-summary">Network (<span class="fl-capture-network-count">0</span>)</summary>
          <ul class="fl-capture-list fl-capture-network-list" data-role="network-list"></ul>
        </details>
        <fl-comment-thread part="comment-thread"></fl-comment-thread>
        <div class="fl-btn-row">
          <button
            type="button"
            class="fl-btn fl-btn-primary fl-popover-resolve"
            data-action="resolve"
          >Resolve</button>
          <button
            type="button"
            class="fl-btn fl-btn-primary fl-popover-reopen"
            data-action="reopen"
            hidden
          >Reopen</button>
          <button
            type="button"
            class="fl-btn fl-btn-secondary"
            data-action="close"
          >Close</button>
        </div>
      </section>
    </dialog>
    <fl-disclosure-modal part="disclosure"></fl-disclosure-modal>
  `;
  return t;
})();
