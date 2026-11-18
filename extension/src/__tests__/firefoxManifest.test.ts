import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Manifest = Record<string, any>;
interface Transform {
  toFirefoxManifest(m: Manifest): Manifest;
  stripPort(p: string): string;
  GECKO_ID: string;
  GECKO_MIN_VERSION: string;
}

// The build script is plain ESM JS (it runs under bare node after vite).
const modulePath = '../../scripts/firefox-manifest.mjs';
let mod: Transform;
beforeAll(async () => {
  mod = (await import(/* @vite-ignore */ modulePath)) as Transform;
});

const chromeManifest: Manifest = JSON.parse(
  readFileSync(resolve(__dirname, '../../manifest.json'), 'utf8'),
);

describe('firefox manifest transform', () => {
  const built: Manifest = {
    ...chromeManifest,
    background: { service_worker: 'service-worker-loader.js', type: 'module' },
  };
  let ff: Manifest;
  beforeAll(() => {
    ff = mod.toFirefoxManifest(built);
  });

  it('swaps service_worker for background.scripts', () => {
    expect(ff.background).toEqual({
      scripts: ['service-worker-loader.js'],
      type: 'module',
    });
  });

  it('declares the gecko id and a min version supporting world: MAIN', () => {
    expect(ff.browser_specific_settings.gecko.id).toBe('pinpoint@pinpoint.dev');
    expect(ff.browser_specific_settings.gecko.strict_min_version).toBe('128.0');
  });

  it('drops port wildcards and Chrome-only keys', () => {
    expect(ff.host_permissions).toEqual(['http://localhost/*', 'http://127.0.0.1/*']);
    expect(JSON.stringify(ff)).not.toMatch(/:\*\//);
    expect(JSON.stringify(ff)).not.toContain('use_dynamic_url');
    expect(Object.keys(ff).filter((k) => k.startsWith('_'))).toEqual([]);
  });

  it('does not mutate the Chrome manifest and leaves non-port patterns alone', () => {
    expect(built.background.service_worker).toBe('service-worker-loader.js');
    expect(mod.stripPort('https://*/*')).toBe('https://*/*');
    expect(mod.stripPort('*://*/*')).toBe('*://*/*');
    expect(mod.stripPort('http://localhost:3001/*')).toBe('http://localhost/*');
  });

  it('throws when there is no service worker to convert', () => {
    expect(() => mod.toFirefoxManifest({ manifest_version: 3 })).toThrow();
  });
});
