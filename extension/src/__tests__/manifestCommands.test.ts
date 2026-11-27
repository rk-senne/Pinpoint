// Chrome refuses to load an extension whose manifest declares an invalid
// `commands[].suggested_key` — the whole extension is rejected, not just the
// shortcut. `Alt+]` / `Alt+[` shipped this way and the extension could not
// be installed at all. This test encodes Chrome's accepted grammar.
//
// https://developer.chrome.com/docs/extensions/reference/api/commands#supported_keys
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const manifest = JSON.parse(
  readFileSync(resolve(__dirname, '../../manifest.json'), 'utf8'),
) as { commands?: Record<string, { suggested_key?: Record<string, string> }> };

const MODIFIERS = new Set(['Ctrl', 'Alt', 'Shift', 'MacCtrl', 'Command', 'Search']);
const KEYS = new Set([
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split(''),
  'Comma', 'Period', 'Home', 'End', 'PageUp', 'PageDown', 'Space', 'Insert', 'Delete',
  'Up', 'Down', 'Left', 'Right',
  'MediaNextTrack', 'MediaPlayPause', 'MediaPrevTrack', 'MediaStop',
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
]);

function isValidShortcut(s: string): boolean {
  const parts = s.split('+');
  const key = parts.pop()!;
  if (!KEYS.has(key)) return false;
  if (parts.length === 0 && !/^(F\d+|Media.*)$/.test(key)) return false;
  if (!parts.every((p) => MODIFIERS.has(p))) return false;
  // Ctrl/Alt/Command/MacCtrl is required; Shift alone is not enough.
  return parts.some((p) => p !== 'Shift' && p !== 'Search') || /^(F\d+|Media.*)$/.test(key);
}

describe('manifest commands', () => {
  const entries = Object.entries(manifest.commands ?? {});

  it('declares at most 4 suggested shortcuts (Chrome limit)', () => {
    expect(entries.filter(([, c]) => c.suggested_key).length).toBeLessThanOrEqual(4);
  });

  for (const [name, cmd] of entries) {
    for (const [platform, key] of Object.entries(cmd.suggested_key ?? {})) {
      it(`${name} (${platform}) uses a Chrome-valid shortcut: ${key}`, () => {
        expect(isValidShortcut(key)).toBe(true);
      });
    }
  }

  it('rejects the previously shipped bracket shortcuts', () => {
    expect(isValidShortcut('Alt+]')).toBe(false);
    expect(isValidShortcut('Alt+[')).toBe(false);
  });
});
