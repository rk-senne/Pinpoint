/**
 * Store-manifest transforms (scripts/firefox-manifest.mjs, safari-manifest.mjs).
 * The scripts are plain ESM without type declarations, so they are loaded via a
 * non-literal specifier (typed `any`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const load = (name: string): Promise<any> => import(/* @vite-ignore */ `../../scripts/${name}.mjs`);
let DATA_COLLECTION_REQUIRED: string[];
let toFirefoxManifest: (m: any) => any;
let toSafariManifest: (m: any) => any;
let chrome: any;
let built: any;

beforeAll(async () => {
  ({ DATA_COLLECTION_REQUIRED, toFirefoxManifest } = await load('firefox-manifest'));
  ({ toSafariManifest } = await load('safari-manifest'));
  chrome = JSON.parse(readFileSync(join(__dirname, '../../manifest.json'), 'utf8'));
  // What CRXJS turns the source manifest into (loader names are hashed at build time).
  built = {
    ...chrome,
    background: { service_worker: 'service-worker-loader.js', type: 'module' },
    content_scripts: [{ ...chrome.content_scripts[0], js: ['assets/content.ts-loader-abc.js'] }],
  };
});

describe('Firefox manifest', () => {
  let ff: any;
  beforeAll(() => { ff = toFirefoxManifest(built); });
  it('uses event-page scripts and a gecko id', () => {
    expect(ff.background.scripts).toEqual(['service-worker-loader.js']);
    expect(ff.background.service_worker).toBeUndefined();
    expect(ff.browser_specific_settings.gecko.id).toBe('pinpoint@pinpoint.dev');
  });
  it('declares only data categories Firefox accepts as required', () => {
    expect(ff.browser_specific_settings.gecko.data_collection_permissions.required).toEqual(DATA_COLLECTION_REQUIRED);
    expect(DATA_COLLECTION_REQUIRED).not.toContain('technicalAndInteraction'); // optional-only category
  });
});

describe('Safari manifest', () => {
  let sf: any;
  beforeAll(() => { sf = toSafariManifest(built); });
  it('uses classic background.js / content.js and no module-only keys', () => {
    expect(sf.background).toEqual({ scripts: ['background.js'] });
    expect(sf.content_scripts[0].js).toEqual(['content.js']);
    expect(sf.web_accessible_resources).toBeUndefined();
  });
  it('maps options_page to options_ui without open_in_tab', () => {
    expect(sf.options_page).toBeUndefined();
    expect(sf.options_ui).toEqual({ page: chrome.options_page });
  });
  it('strips port wildcards and comment keys, keeps permissions', () => {
    expect(JSON.stringify(sf)).not.toMatch(/:\*\//);
    expect(Object.keys(sf).some((k: string) => k.startsWith('_'))).toBe(false);
    expect(sf.permissions).toEqual(chrome.permissions);
    expect(sf.browser_specific_settings.safari.strict_min_version).toBe('16.4');
  });
  it('rejects a manifest without a service worker', () => {
    expect(() => toSafariManifest({ ...built, background: {} })).toThrow();
  });
});
