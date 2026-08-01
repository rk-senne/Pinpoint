/**
 * 404 Not Found page — catch-all fallback for unmatched routes.
 */
export function mountNotFoundPage(root: HTMLElement): void {
  const tpl = document.getElementById('not-found-page') as HTMLTemplateElement | null;
  if (!tpl) return;
  root.appendChild(tpl.content.cloneNode(true));
}
