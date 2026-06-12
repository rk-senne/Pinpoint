import type { OAuthProfile, OAuthProvider } from '../../../domain/auth/usecases/oauthLogin.js';

export class GitHubOAuthProvider implements OAuthProvider {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  getAuthorizationUrl(state: string, redirectUri: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      scope: 'read:user user:email',
      state,
    });
    return `https://github.com/login/oauth/authorize?${params.toString()}`;
  }

  async exchangeCode(code: string, redirectUri: string): Promise<string> {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });
    if (!res.ok) throw new Error(`GitHub token exchange failed: ${res.status}`);
    const data = (await res.json()) as { access_token?: string; error?: string };
    if (!data.access_token) throw new Error(`GitHub token error: ${data.error}`);
    return data.access_token;
  }

  async getProfile(accessToken: string): Promise<OAuthProfile> {
    const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' };

    const userRes = await fetch('https://api.github.com/user', { headers });
    if (!userRes.ok) throw new Error(`GitHub user fetch failed: ${userRes.status}`);
    const user = (await userRes.json()) as { id: number; login: string; name?: string; avatar_url?: string; email?: string };

    let email = user.email;
    if (!email) {
      const emailsRes = await fetch('https://api.github.com/user/emails', { headers });
      if (emailsRes.ok) {
        const emails = (await emailsRes.json()) as { email: string; primary: boolean; verified: boolean }[];
        const primary = emails.find((e) => e.primary && e.verified);
        email = primary?.email ?? emails.find((e) => e.verified)?.email;
      }
    }

    if (!email) throw new Error('GitHub account has no verified email.');

    return {
      id: String(user.id),
      email,
      name: user.name || user.login,
      avatarUrl: user.avatar_url,
    };
  }
}
