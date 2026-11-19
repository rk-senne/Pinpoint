import { describe, expect, it } from 'vitest';
import { buildAuthorizeUrl, loadIntegrationOAuthProviders } from './oauthExchange.js';

describe('integration OAuth defaults: ClickUp and Asana', () => {
  const env = {
    INTEGRATION_CLICKUP_CLIENT_ID: 'cu-id',
    INTEGRATION_CLICKUP_CLIENT_SECRET: 'cu-secret',
    INTEGRATION_ASANA_CLIENT_ID: 'as-id',
    INTEGRATION_ASANA_CLIENT_SECRET: 'as-secret',
    INTEGRATION_ASANA_SCOPES: 'tasks:write projects:read',
  };

  it('are enabled only when both id and secret are set', () => {
    expect(Object.keys(loadIntegrationOAuthProviders({ INTEGRATION_ASANA_CLIENT_ID: 'x' }))).toEqual([]);
    expect(Object.keys(loadIntegrationOAuthProviders(env)).sort()).toEqual(['asana', 'clickup']);
  });

  it('use the documented endpoints', () => {
    const p = loadIntegrationOAuthProviders(env);
    expect(p.clickup).toMatchObject({
      authorizeUrl: 'https://app.clickup.com/api',
      tokenUrl: 'https://api.clickup.com/api/v2/oauth/token',
      tokenRequest: 'json',
    });
    expect(p.asana).toMatchObject({
      authorizeUrl: 'https://app.asana.com/-/oauth_authorize',
      tokenUrl: 'https://app.asana.com/-/oauth_token',
      scopes: ['tasks:write', 'projects:read'],
    });
  });

  it('ClickUp sends no scope parameter', () => {
    const url = new URL(buildAuthorizeUrl(loadIntegrationOAuthProviders(env).clickup!, { state: 's', redirectUri: 'https://a/cb' }));
    expect(url.searchParams.has('scope')).toBe(false);
    expect(url.searchParams.get('client_id')).toBe('cu-id');
  });
});
