/* eslint-disable no-restricted-syntax */
/**
 * CSP-Strict Resilience audit (task 41.1, Requirement 49.1).
 *
 * The Extension overlay must continue to render on host pages with strict
 * `Content-Security-Policy` headers (e.g. `default-src 'none'; script-src 'self';
 * style-src 'self'`). That implies the runtime never relies on:
 *
 *   - inline event handler attributes (`onclick="…"`, `onkeydown="…"`, …),
 *   - inline `<style>` strings on host elements (`element.style.cssText = …`,
 *     `element.setAttribute('style', …)`, or a `style="…"` attribute baked
 *     into a `<template>`'s HTML string),
 *   - `eval`-class APIs (`eval(...)`, `new Function(...)`,
 *     `setTimeout("string", …)`, `setInterval("string", …)`).
 *
 * This test enforces the audit at unit-test time so any future regression
 * fails CI alongside the rest of the `extension` test suite. The project
 * does not (yet) install ESLint — the same enforcement that an
 * `eslint-plugin-no-unsafe-css-injection`-style rule would give us is
 * implemented here as a regex sweep over the workspace's own source
 * files. Tests, scripts, and `node_modules` are excluded so this only
 * polices first-party runtime code.
 *
 * The patterns intentionally err on the side of false positives — every
 * exception is documented in `ALLOWED_VIOLATIONS` below with a comment
 * explaining why it is safe. New entries require human review.
 *
 * The audit is also reflected in the documentation block at the top of
 * `extension/src/content.ts` — see "CSP-strict audit (task 41.1)" there
 * for the human-readable summary.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const EXTENSION_ROOT = join(__dirname, '..', '..');
const SRC_ROOT = join(EXTENSION_ROOT, 'src');

interface Violation {
  /** Path relative to `extension/`. */
  readonly file: string;
  /** 1-based line number. */
  readonly line: number;
  /** The matched text (trimmed). */
  readonly match: string;
  /** Which rule was violated. */
  readonly rule: string;
}

interface AuditRule {
  /** Short identifier referenced in failures and the allow-list. */
  readonly id: string;
  /** Regex tested against each line. */
  readonly pattern: RegExp;
  /** Human-readable explanation of what the rule forbids. */
  readonly description: string;
}

/**
 * The audit rules. Each pattern is tested per-line so the failure
 * messages can include line numbers and matched fragments. Patterns are
 * intentionally simple — refining them later should keep the existing
 * `ALLOWED_VIOLATIONS` entries unchanged.
 */
const RULES: readonly AuditRule[] = [
  {
    id: 'no-eval',
    pattern: /\beval\s*\(/,
    description: 'Direct `eval(...)` is forbidden under strict CSP.',
  },
  {
    id: 'no-new-function',
    pattern: /\bnew\s+Function\s*\(/,
    description: '`new Function(...)` is `eval`-class and forbidden under strict CSP.',
  },
  {
    id: 'no-string-set-timeout',
    pattern: /\bsetTimeout\s*\(\s*['"`]/,
    description: '`setTimeout(string, …)` invokes the `eval`-class string compiler.',
  },
  {
    id: 'no-string-set-interval',
    pattern: /\bsetInterval\s*\(\s*['"`]/,
    description: '`setInterval(string, …)` invokes the `eval`-class string compiler.',
  },
  {
    id: 'no-inline-event-handler-attr',
    // Match HTML attribute setters that look like inline event handlers,
    // e.g. setAttribute('onclick', ...) or `onclick="…"` baked into a
    // template literal.
    pattern:
      /(setAttribute\s*\(\s*['"]on\w+['"])|(\son(?:click|input|change|submit|focus|blur|load|error|keyup|keydown|mouseup|mousedown|mouseover|mouseout|pointerdown|pointerup|pointermove)\s*=\s*['"])/,
    description:
      'Inline event handler attributes (`onclick=…`, `setAttribute("onfoo", …)`) are forbidden under strict CSP `script-src`.',
  },
  {
    id: 'no-inline-style-attribute-in-template',
    // Match a literal `style="…"` attribute baked into HTML strings (e.g.
    // a `<template>`'s `innerHTML` or any `setAttribute('style', …)`
    // call). Also matches `style="…"` inside template strings.
    pattern: /(\sstyle\s*=\s*['"])|(setAttribute\s*\(\s*['"]style['"])/,
    description:
      'Inline `style="…"` attributes are forbidden under strict CSP `style-src`. Use a class on the shared stylesheet instead.',
  },
  {
    id: 'no-cssText-assignment',
    pattern: /\.cssText\s*=/,
    description:
      '`element.style.cssText = …` writes the entire inline `style` attribute and is forbidden under strict CSP `style-src`. Assign per-property instead.',
  },
];

/**
 * Allow-list of *current* exceptions. Each entry is keyed by
 * `file:rule` and carries a human-readable comment so the next person
 * adding a violation has to revisit and document it.
 *
 * A `match` predicate narrows the exception to a specific surface; if a
 * second violation appears in the same file with a different match the
 * audit will still flag it. This keeps the allow-list from acting as a
 * blanket file-level escape hatch.
 *
 * The audit STARTS empty — every existing violation has been fixed in
 * the same commit as this test. The allow-list shape is preserved so
 * future, intentional exceptions (e.g. a sandboxed iframe document
 * built explicitly under a relaxed inline-style policy) can be added
 * with documentation rather than bypassing the audit entirely.
 */
const ALLOWED_VIOLATIONS: ReadonlyArray<{
  readonly file: string;
  readonly rule: string;
  readonly match: RegExp;
  readonly reason: string;
}> = [];

/**
 * Files under `extension/src/` whose primary purpose is testing the
 * audit itself or quoting forbidden patterns inside string literals as
 * part of their own test setup. Excluded from the sweep so the audit
 * does not flag its own `RULES` table.
 */
const FILE_EXCLUDE_PATTERNS: readonly RegExp[] = [
  /[\\/]__tests__[\\/]cspAudit\.test\.ts$/,
];

/** Recursively collect `*.ts` / `*.tsx` files under `dir`, excluding tests. */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      let info;
      try {
        info = statSync(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!info.isFile()) continue;
      if (!/\.(ts|tsx)$/.test(entry)) continue;
      if (/\.test\.tsx?$/.test(entry)) continue;
      if (/\.property\.test\.tsx?$/.test(entry)) continue;
      if (FILE_EXCLUDE_PATTERNS.some((p) => p.test(full))) continue;
      out.push(full);
    }
  }
  return out;
}

/**
 * Strip line-comment and block-comment content from a source line so the
 * audit does not flag occurrences that exist only in comments (e.g.
 * documentation explaining what `cssText` is). Block comments are only
 * stripped on a single line; multi-line block comments fall through and
 * may produce false positives — which is fine because in practice the
 * forbidden patterns never appear inside long doc comments anyway, and
 * a false positive can be silenced with `eslint-disable`-style sentinel
 * comments below.
 */
function stripComments(line: string): string {
  let result = line;
  // Strip block comments on the same line.
  result = result.replace(/\/\*[^]*?\*\//g, '');
  // Strip from `//` to end of line, but not inside strings. The naive
  // approach below loses some accuracy in lines that contain both
  // strings and comments; for this audit it is good enough because the
  // RULES patterns themselves do not match inside well-formed strings.
  const lineCommentIdx = result.indexOf('//');
  if (lineCommentIdx >= 0) {
    // Heuristic: only strip if the `//` is not inside a string literal.
    // Very rough — we count unescaped `'`, `"`, and `` ` `` before the
    // `//` and assume an even count means we are outside a string.
    const before = result.slice(0, lineCommentIdx);
    const sq = (before.match(/(?<!\\)'/g) || []).length;
    const dq = (before.match(/(?<!\\)"/g) || []).length;
    const bt = (before.match(/(?<!\\)`/g) || []).length;
    if (sq % 2 === 0 && dq % 2 === 0 && bt % 2 === 0) {
      result = before;
    }
  }
  return result;
}

/**
 * Lines containing the sentinel string below are skipped. Use this for
 * intentional documentation that quotes a forbidden pattern (e.g. an
 * audit doc-block in `content.ts`).
 */
const AUDIT_OPT_OUT_SENTINEL = 'csp-audit-allow';

function auditFile(filepath: string): Violation[] {
  const content = readFileSync(filepath, 'utf8');
  const lines = content.split(/\r?\n/);
  const relPath = relative(EXTENSION_ROOT, filepath);
  const violations: Violation[] = [];

  // Track block-comment state so we skip lines fully inside a `/* … */`
  // block. The single-line stripper above does not handle multi-line
  // blocks; this pass complements it.
  let insideBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    let raw = lines[i];
    if (insideBlockComment) {
      const closeIdx = raw.indexOf('*/');
      if (closeIdx === -1) {
        continue;
      }
      raw = raw.slice(closeIdx + 2);
      insideBlockComment = false;
    } else {
      // Detect entry into a multi-line block comment that does not
      // close on the same line.
      const openIdx = raw.indexOf('/*');
      const closeIdx = raw.indexOf('*/', openIdx + 2);
      if (openIdx >= 0 && closeIdx === -1) {
        insideBlockComment = true;
        raw = raw.slice(0, openIdx);
      }
    }

    const stripped = stripComments(raw);
    if (stripped.includes(AUDIT_OPT_OUT_SENTINEL)) continue;

    for (const rule of RULES) {
      const m = rule.pattern.exec(stripped);
      if (!m) continue;

      // Allow-list lookup.
      const allowed = ALLOWED_VIOLATIONS.find(
        (a) =>
          a.file === relPath.replace(/\\/g, '/') &&
          a.rule === rule.id &&
          a.match.test(m[0]),
      );
      if (allowed) continue;

      violations.push({
        file: relPath.replace(/\\/g, '/'),
        line: i + 1,
        match: m[0],
        rule: rule.id,
      });
    }
  }

  return violations;
}

describe('CSP-Strict audit (Req 49.1, task 41.1)', () => {
  it('the extension source tree is free of CSP-incompatible patterns', () => {
    const files = collectSourceFiles(SRC_ROOT);
    expect(files.length).toBeGreaterThan(0);

    const violations: Violation[] = [];
    for (const file of files) {
      violations.push(...auditFile(file));
    }

    if (violations.length > 0) {
      const lines = violations.map(
        (v) =>
          `  ${v.file}:${v.line}  [${v.rule}]  ${v.match.trim()}`,
      );
      throw new Error(
        `Found ${violations.length} CSP-incompatible pattern(s):\n${lines.join('\n')}\n` +
          'Each violation must either be fixed (preferred) or explicitly added to ' +
          '`ALLOWED_VIOLATIONS` in extension/src/__tests__/cspAudit.test.ts with a justification.',
      );
    }

    expect(violations).toEqual([]);
  });

  it('exposes the rule set so future tasks can extend it', () => {
    expect(RULES.length).toBeGreaterThanOrEqual(7);
    const ids = RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
