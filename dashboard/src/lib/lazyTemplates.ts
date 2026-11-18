/**
 * On-demand `<template>` registration for code-split routes.
 *
 * `index.html` carries only the templates needed by the always-loaded shell
 * and the high-traffic routes. Low-traffic pages keep their templates in a
 * co-located `*.templates.html` file imported with Vite's `?raw` suffix, so
 * the markup ships in the page's lazy chunk and is parsed into the document
 * the first time the page mounts. `cloneTemplate()` stays synchronous and
 * unchanged — it just finds the template by id as before.
 *
 * The markup is a build-time constant from this repo (never user input), so
 * parsing it with `<template>.innerHTML` is safe.
 */

const registered = new Set<string>();

/** Parse and append every `<template id=…>` in `markup` not already present. */
export function registerTemplates(key: string, markup: string): void {
  if (registered.has(key)) return;
  const holder = document.createElement('template');
  // eslint-disable-next-line no-restricted-syntax -- markup is a build-time constant from this repo, parsed inertly in a <template>
  holder.innerHTML = markup;
  for (const tpl of Array.from(holder.content.querySelectorAll('template[id]'))) {
    if (!document.getElementById(tpl.id)) document.body.appendChild(tpl);
  }
  registered.add(key);
}

/** Test-only reset. */
export function _resetLazyTemplatesForTests(): void {
  registered.clear();
}
