// Vite `?raw` imports of the Markdown legal documents (docs/legal/*.md) —
// bundled at build time and rendered by pages/LegalPage.ts.
declare module '*.md?raw' {
  const content: string;
  export default content;
}
