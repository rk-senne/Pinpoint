// PP-01 regression: every domain/HTTP `eventBus.emit({...})` call site must
// name a room, because the Socket.IO bus drops room-less events.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === '__tests__' || name === 'migrations') continue;
      walk(p, out);
    } else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

describe('event bus emitters', () => {
  it('every emit({ type, ... }) literal carries a room', () => {
    const offenders: string[] = [];
    for (const dir of ['domain', 'adapters/inbound']) {
      for (const file of walk(join(root, dir))) {
        const src = readFileSync(file, 'utf8');
        const re = /[eE]ventBus\??\.emit\(\{([\s\S]*?)\n\s*\}\);/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(src))) {
          if (!/\broom\b/.test(m[1]!)) offenders.push(`${file.replace(root, '')}: ${m[1]!.trim().split('\n')[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
