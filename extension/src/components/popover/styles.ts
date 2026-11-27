// <fl-popover> element-scoped CSS (extracted from Popover.ts).

/**
 * Element-scoped CSS layered on top of the shared overlay stylesheet. We
 * only declare rules that touch the `<dialog>` defaults (border, padding,
 * UA-modal centering) and the autocomplete positioning; the rest of the
 * popover (`.fl-popover`, `.fl-popover-tabs`, `.fl-severity-*`, `.fl-btn`,
 * `.fl-textarea`) is already styled by the shared stylesheet so the palette
 * has a single source of truth (Req 26.1, design key decision #11).
 */
export const POPOVER_CSS = `
:host { display: contents; }
dialog.fl-popover {
  border: none;
  background: #fff;
  padding: 16px;
  /* Defeat the user-agent's modal-centering for top-layer dialogs.
     showModal() (task 33.1) places the dialog in the top layer where the
     UA stylesheet applies margin: auto to center it; we want our inline
     style.left/top (set by #applyPosition) to win so the popover
     anchors at (pageX, pageY+30) like the legacy React placement. The
     #openDialog method also sets style.margin = '0' programmatically as
     a belt-and-braces guard against host pages that override these
     selectors. */
  margin: 0;
  /* The .fl-popover rule in the shared stylesheet already sets
     position:absolute, box-shadow, border-radius, min-width,
     pointer-events, and z-index. The rules above just neutralize the
     user-agent dialog defaults so the shared rule wins. */
}
dialog.fl-popover[open] { display: block; }
dialog.fl-popover:focus { outline: none; }
dialog.fl-popover:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }
/* Transparent backdrop so the page underneath stays visible while the
   modal dialog has focus-trap + Escape semantics (Req 42.1, 42.2, 42.3). */
dialog.fl-popover::backdrop { background: transparent; }
.fl-popover-textarea-wrap { position: relative; }
.fl-popover-textarea-wrap fl-mention-autocomplete {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 1;
}
.fl-annotation-summary { margin-bottom: 8px; }
.fl-annotation-summary .fl-annotation-type { text-transform: capitalize; }
.fl-annotation-body { margin-bottom: 12px; white-space: pre-wrap; }
.fl-environment-details { margin-bottom: 8px; font-size: 12px; }
.fl-environment-details pre { font-size: 11px; white-space: pre-wrap; }
/* Captured Console / Network sections (Req 36.3, task 27.4).
   Both render below the environment <details> in view mode whenever the
   annotation carries a non-empty buffer. The list is monospace so log
   lines line up; max-height + scroll keeps a noisy buffer from making
   the popover taller than the viewport. */
.fl-capture-details { margin-bottom: 8px; font-size: 12px; }
.fl-capture-details[hidden] { display: none; }
.fl-capture-list {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
  max-height: 180px;
  overflow-y: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11px;
  line-height: 1.4;
}
.fl-capture-list li {
  padding: 2px 4px;
  border-bottom: 1px solid #f0f0f0;
  word-break: break-word;
}
.fl-capture-list li:last-child { border-bottom: none; }
.fl-capture-console-level {
  display: inline-block;
  min-width: 36px;
  padding: 0 4px;
  margin-right: 6px;
  border-radius: 3px;
  text-transform: uppercase;
  font-weight: 600;
  font-size: 10px;
  color: #fff;
  background: #555;
}
.fl-capture-console-level[data-level="warn"] { background: #d97706; }
.fl-capture-console-level[data-level="error"] { background: #c53030; }
.fl-capture-console-time { color: #888; margin-right: 6px; }
.fl-capture-console-stack { margin: 4px 0 0; font-size: 10px; color: #666; }
.fl-capture-console-stack pre {
  white-space: pre-wrap;
  font-size: 10px;
  margin: 0;
  padding: 4px 6px;
  background: #f7f7f7;
  border-radius: 3px;
}
.fl-capture-network-method {
  display: inline-block;
  min-width: 36px;
  margin-right: 6px;
  font-weight: 600;
  color: #2c5282;
}
.fl-capture-network-status { color: #555; }
.fl-capture-network-status[data-bad="true"] { color: #c53030; font-weight: 600; }
/* Create-mode environment summary (task 19.2, Req 17.1, 17.5).
   A compact one-line badge rendered below the textarea/mentions block
   and above the button row so the user sees the browser/OS/device that
   will be attached on submit. The label text is filled in by
   #renderEnvironmentSummary() from the same parseUserAgent +
   Brave/Arc override pipeline used at submit time. */
.fl-environment-summary {
  display: block;
  margin: 6px 0 4px;
  padding: 4px 8px;
  background: #f5f5f5;
  color: #555;
  border: 1px solid #e0e0e0;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.4;
}
.fl-environment-summary[hidden] { display: none; }
.fl-environment-summary-label {
  font-weight: 600;
  color: #333;
  margin-right: 6px;
}
.fl-triage-hint {
  display: block;
  margin: 4px 0;
  padding: 4px 8px;
  background: #fffbea;
  color: #744210;
  border: 1px solid #f6e05e;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.4;
}
.fl-triage-hint[hidden] { display: none; }
/* Co-viewer presence row (Req 6.6, 6.7). Rendered in the popover view-mode
   header beside the type/severity summary. Hidden when no other members
   are viewing the same annotation. */
.fl-popover-viewers {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  font-size: 12px;
  color: #555;
}
.fl-popover-viewers[hidden] { display: none; }
.fl-popover-viewers-list {
  display: inline-flex;
  align-items: center;
}
.fl-popover-viewer-bubble {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: #1a1a1a;
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  margin-right: -6px;
  border: 2px solid #fff;
}
.fl-popover-viewer-bubble:last-child { margin-right: 0; }
.fl-popover-viewers-label { margin-left: 6px; }
/* Target-stale warning (Req 44.6, task 36.7). Rendered above the
   annotation summary in view mode whenever the optimistic pin's
   stored selector failed to re-resolve on Outbox replay — mirrors the
   warning ring on fl-annotation-pin[data-fallback="true"] so the
   pin and the popover surface the same signal. The element is kept
   in the template (rather than created on demand) so the focus
   trap inside <dialog> does not have to recompute its tabbable
   set on every render. */
.fl-target-stale-warning {
  display: block;
  margin-bottom: 8px;
  padding: 6px 8px;
  border-radius: 4px;
  background: #fff8e1;
  border: 1px solid #f5c542;
  color: #5c4400;
  font-size: 12px;
  font-weight: 600;
}
.fl-target-stale-warning[hidden] { display: none; }
/* "Attach screenshot" toggle in the create-section button row (Req 34.2 /
   Task 25.4). Sits between the Cancel and Submit buttons so the
   per-annotation choice is one glance away from the action it modifies. */
.fl-popover-capture-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-right: auto;
  font-size: 12px;
  color: #444;
  cursor: pointer;
  user-select: none;
}
.fl-popover-capture-toggle input[type="checkbox"] {
  margin: 0;
  cursor: pointer;
}
`;
