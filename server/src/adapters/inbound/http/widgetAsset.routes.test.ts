import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { request } from '../../../__tests__/supertestClient.js';

import {
  createWidgetAssetRoutes,
  resolveWidgetDistDir,
  WIDGET_BUNDLE_FILENAME,
} from './widgetAsset.routes.js';

function makeApp(deps: Parameters<typeof createWidgetAssetRoutes>[0]): express.Express {
  const app = express();
  app.use('/widget', createWidgetAssetRoutes(deps));
  return app;
}

describe('widgetAsset.routes — GET /widget/pinpoint-widget.js', () => {
  it('serves the built bundle with public, cacheable, CORS-open JS headers', async () => {
    const bundle = 'var Pinpoint=(function(){return{init:function(){}}})();';
    const readFileImpl = vi.fn().mockResolvedValue(Buffer.from(bundle, 'utf8'));
    const app = makeApp({ widgetDistDir: '/fake/dist', readFileImpl });

    const res = await request(app).get(`/widget/${WIDGET_BUNDLE_FILENAME}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/javascript');
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.text).toContain('Pinpoint');
    // Resolves the path from the configured dist dir + the Vite output name.
    expect(readFileImpl).toHaveBeenCalledWith(`/fake/dist/${WIDGET_BUNDLE_FILENAME}`);
  });

  it('404s cleanly with a build hint when the bundle is not built', async () => {
    const readFileImpl = vi.fn().mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );
    const app = makeApp({ widgetDistDir: '/fake/dist', readFileImpl });

    const res = await request(app).get(`/widget/${WIDGET_BUNDLE_FILENAME}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('WIDGET_BUNDLE_NOT_BUILT');
    expect(res.body.error.message).toContain('npm run build');
  });

  it('does not expose any other path', async () => {
    const readFileImpl = vi.fn().mockResolvedValue('x');
    const app = makeApp({ widgetDistDir: '/fake/dist', readFileImpl });

    const res = await request(app).get('/widget/other.js');
    expect(res.status).toBe(404);
    // The fallback 404 here is Express's default (no route matched), not our
    // handler — so readFile is never reached.
    expect(readFileImpl).not.toHaveBeenCalled();
  });
});

describe('resolveWidgetDistDir', () => {
  it('prefers an explicit absolute dir', () => {
    expect(resolveWidgetDistDir('/abs/widget/dist')).toBe('/abs/widget/dist');
  });

  it('resolves a relative explicit dir against cwd', () => {
    const resolved = resolveWidgetDistDir('rel/dist');
    expect(resolved.startsWith('/')).toBe(true);
    expect(resolved.endsWith('rel/dist')).toBe(true);
  });

  it('falls back to a widget/dist path when nothing is provided', () => {
    const prev = process.env.WIDGET_DIST_DIR;
    delete process.env.WIDGET_DIST_DIR;
    try {
      const resolved = resolveWidgetDistDir();
      expect(resolved.endsWith('widget/dist')).toBe(true);
    } finally {
      if (prev !== undefined) process.env.WIDGET_DIST_DIR = prev;
    }
  });
});
