/**
 * DOMTargetResolver — computes CSS selector path and XPath for a clicked DOM element.
 * Selector resolution: attempt CSS selector first, fall back to XPath, then stored page coordinates.
 */
import type { DOMTarget } from '@pinpoint/shared';

export interface ResolvedTarget {
  element: Element | null;
  domTarget: DOMTarget;
  pageX: number;
  pageY: number;
  warning?: boolean; // true when falling back to coordinates
}

export const DOMTargetResolver = {
  /**
   * Compute a DOMTarget for a given element.
   */
  resolve(element: Element): ResolvedTarget {
    const rect = element.getBoundingClientRect();
    const pageX = rect.left + window.scrollX;
    const pageY = rect.top + window.scrollY;
    const textSnippet = (element.textContent || '').trim().slice(0, 100);

    const domTarget: DOMTarget = {
      cssSelector: computeCssSelector(element),
      xpath: computeXPath(element),
      pageX,
      pageY,
      tagName: element.tagName,
      textSnippet,
    };

    return { element, domTarget, pageX, pageY };
  },

  /**
   * Resolve a stored DOMTarget back to a DOM element.
   * Tries CSS selector first, then XPath, then falls back to coordinates with warning.
   */
  resolveSelector(target: DOMTarget): Element | null {
    // 1. Try CSS selector
    if (target.cssSelector) {
      try {
        const el = document.querySelector(target.cssSelector);
        if (el) return el;
      } catch { /* invalid selector, fall through */ }
    }

    // 2. Try XPath
    if (target.xpath) {
      try {
        const result = document.evaluate(
          target.xpath,
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null
        );
        if (result.singleNodeValue instanceof Element) {
          return result.singleNodeValue;
        }
      } catch { /* invalid xpath, fall through */ }
    }

    // 3. Fall back to coordinates — return null (caller uses stored pageX/pageY)
    return null;
  },
};

/**
 * Compute a CSS selector path for an element.
 * Produces a unique selector by walking up the DOM tree.
 */
export function computeCssSelector(element: Element): string {
  const parts: string[] = [];
  let current: Element | null = element;

  while (current && current !== document.documentElement) {
    if (current.id) {
      parts.unshift(`#${CSS.escape(current.id)}`);
      break;
    }

    let selector = current.tagName.toLowerCase();
    const parent: Element | null = current.parentElement;

    if (parent) {
      const siblings = Array.from(parent.children).filter(
        (c: Element) => c.tagName === current!.tagName
      );
      if (siblings.length > 1) {
        const index = siblings.indexOf(current) + 1;
        selector += `:nth-of-type(${index})`;
      }
    }

    parts.unshift(selector);
    current = parent;
  }

  return parts.join(' > ');
}

/**
 * Compute an XPath for an element.
 */
export function computeXPath(element: Element): string {
  const parts: string[] = [];
  let current: Element | null = element;

  while (current && current.nodeType === Node.ELEMENT_NODE) {
    let index = 1;
    let sibling = current.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === current.tagName) index++;
      sibling = sibling.previousElementSibling;
    }
    const tagName = current.tagName.toLowerCase();
    parts.unshift(`${tagName}[${index}]`);
    current = current.parentElement;
  }

  return '/' + parts.join('/');
}
