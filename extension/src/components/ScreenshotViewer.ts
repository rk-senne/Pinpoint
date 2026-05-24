/**
 * `<fl-screenshot-viewer>` — read-only Custom Element that renders a
 * screenshot bitmap with the persisted Markup_Document SVG composited on
 * top (Req 35.2 / Task 26.2).
 *
 * The popover and the dashboard detail panel both display annotation
 * screenshots. Rather than duplicate the compositing logic, both surfaces
 * mount this element with the screenshot URL and, optionally, an
 * `annotationId`. The element fetches the sibling
 * `<screenshot_object_key>.markup.json` over the standard auth gate and
 * overlays an SVG layer when present. Best-effort: when there is no
 * markup, or the fetch fails, we still render the bitmap.
 *
 * Clicking the viewer dispatches an `edit-request` `CustomEvent` so a
 * host can open `<fl-markup-editor>` in response (existing behavior — the
 * viewer itself never mutates state).
 */
import type { MarkupDocument } from '@pinpoint/shared';
import { renderMarkupSvg } from '@pinpoint/shared';
import { adoptStyles } from '../styles/sharedStyleSheet';
import { withBoundary } from '../lib/withBoundary';
import { apiFetch } from '../lib/api';

const VIEWER_CSS = `
:host {
  display: block;
  position: relative;
}
.fl-screenshot-stage {
  position: relative;
  display: inline-block;
  max-width: 100%;
  cursor: pointer;
}
.fl-screenshot-stage img.fl-screenshot-img {
  display: block;
  max-width: 100%;
  height: auto;
  border: 1px solid #ddd;
  border-radius: 6px;
  background: #f5f5f5;
}
.fl-screenshot-stage .fl-screenshot-overlay {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
`;

const TEMPLATE = (() => {
  const t = document.createElement('template');
  t.innerHTML = `
    <style>${VIEWER_CSS}</style>
    <div class="fl-screenshot-stage" part="stage" role="img" tabindex="0">
      <img class="fl-screenshot-img" part="image" alt="Annotation screenshot" />
      <div class="fl-screenshot-overlay" part="overlay"></div>
    </div>
  `;
  return t;
})();

export interface ScreenshotEditRequestDetail {
  annotationId: string | null;
  imageUrl: string | null;
  markupDocument: MarkupDocument | null;
}

export class FlScreenshotViewer extends HTMLElement {
  static readonly tagName = 'fl-screenshot-viewer';

  #imageUrl: string | null = null;
  #annotationId: string | null = null;
  #markupDocument: MarkupDocument | null = null;
  #naturalWidth = 0;
  #naturalHeight = 0;
  /** Increments on every prop change so stale fetches can be discarded. */
  #fetchToken = 0;

  #stage!: HTMLElement;
  #img!: HTMLImageElement;
  #overlay!: HTMLElement;

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    adoptStyles(root);
    root.appendChild(TEMPLATE.content.cloneNode(true));
    this.#stage = root.querySelector('.fl-screenshot-stage') as HTMLElement;
    this.#img = root.querySelector('img.fl-screenshot-img') as HTMLImageElement;
    this.#overlay = root.querySelector('.fl-screenshot-overlay') as HTMLElement;
  }

  connectedCallback(): void {
    this.#stage.addEventListener('click', this.#onStageClick);
    this.#img.addEventListener('load', this.#onImageLoad);
  }

  disconnectedCallback(): void {
    this.#stage.removeEventListener('click', this.#onStageClick);
    this.#img.removeEventListener('load', this.#onImageLoad);
  }

  /** URL of the screenshot bitmap. Setting reloads the image. */
  get imageUrl(): string | null {
    return this.#imageUrl;
  }
  set imageUrl(next: string | null | undefined) {
    const value = next ?? null;
    if (value === this.#imageUrl) return;
    this.#imageUrl = value;
    if (value) {
      this.#img.src = value;
      this.#stage.hidden = false;
    } else {
      this.#img.removeAttribute('src');
      this.#stage.hidden = true;
    }
    this.#renderOverlay();
  }

  /**
   * Annotation id. When set the viewer fetches the sibling markup JSON
   * over `/api/v1/annotations/:id/markup` and renders the SVG overlay.
   */
  get annotationId(): string | null {
    return this.#annotationId;
  }
  set annotationId(next: string | null | undefined) {
    const value = next ?? null;
    if (value === this.#annotationId) return;
    this.#annotationId = value;
    void this.#refreshMarkup();
  }

  /**
   * Pre-resolved Markup_Document. Setting this skips the fetch — useful
   * when the host already has the document in memory (e.g. immediately
   * after the user submits an annotation).
   */
  get markupDocument(): MarkupDocument | null {
    return this.#markupDocument;
  }
  set markupDocument(next: MarkupDocument | null | undefined) {
    this.#markupDocument = next ?? null;
    this.#renderOverlay();
  }

  async #refreshMarkup(): Promise<void> {
    const token = ++this.#fetchToken;
    if (!this.#annotationId) {
      this.#markupDocument = null;
      this.#renderOverlay();
      return;
    }
    try {
      const result = await apiFetch<{ markupDocument: MarkupDocument }>(
        `/annotations/${encodeURIComponent(this.#annotationId)}/markup`,
      );
      if (token !== this.#fetchToken) return; // a newer setter superseded us
      this.#markupDocument = result?.markupDocument ?? null;
    } catch {
      // 404 / network failure / no markup persisted — viewer renders the
      // bitmap alone. Best-effort per the task description.
      if (token !== this.#fetchToken) return;
      this.#markupDocument = null;
    }
    this.#renderOverlay();
  }

  #onImageLoad = (): void => {
    this.#naturalWidth = this.#img.naturalWidth;
    this.#naturalHeight = this.#img.naturalHeight;
    this.#renderOverlay();
  };

  #onStageClick = (): void => {
    this.dispatchEvent(
      new CustomEvent<ScreenshotEditRequestDetail>('edit-request', {
        detail: {
          annotationId: this.#annotationId,
          imageUrl: this.#imageUrl,
          markupDocument: this.#markupDocument,
        },
        bubbles: true,
        composed: true,
      }),
    );
  };

  #renderOverlay(): void {
    if (!this.#markupDocument || this.#naturalWidth === 0 || this.#naturalHeight === 0) {
      this.#overlay.replaceChildren();
      return;
    }
    const svg = renderMarkupSvg(
      this.#markupDocument,
      this.#naturalWidth,
      this.#naturalHeight,
    );
    // The SVG comes from the shared renderer which only emits the shape
    // primitives we control plus a static `<defs>` block. innerHTML is
    // safe here because shape values originate in the user's own
    // markup editor (and the server validates them on the way in via
    // `MarkupDocumentSchema`).
    this.#overlay.innerHTML = svg;
  }
}

if (
  typeof customElements !== 'undefined' &&
  !customElements.get(FlScreenshotViewer.tagName)
) {
  withBoundary(FlScreenshotViewer.prototype, 'connectedCallback');
  withBoundary(FlScreenshotViewer.prototype, 'disconnectedCallback');
  customElements.define(FlScreenshotViewer.tagName, FlScreenshotViewer);
}

declare global {
  interface HTMLElementTagNameMap {
    'fl-screenshot-viewer': FlScreenshotViewer;
  }
  interface HTMLElementEventMap {
    'edit-request': CustomEvent<ScreenshotEditRequestDetail>;
  }
}
