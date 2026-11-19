// "Finish setup" support for integrations: after OAuth the stored token has no
// delivery target (Jira project, Linear team, GitHub repo, ...). This module
// lists the targets a token can reach and validates the config an admin picks.
//
// All outbound calls go through `safeFetch` (https-only, DNS-pinned, private
// ranges blocked) with a hard timeout and a capped response body. The token is
// only ever sent to the provider and never logged or returned.

import { z } from 'zod';
import { readBodyCapped, safeFetch as defaultSafeFetch, type EgressGuardOptions } from '../egressGuard.js';

export const TARGET_PROVIDERS = ['github', 'linear', 'jira', 'clickup', 'asana'] as const;
export type TargetProviderName = (typeof TARGET_PROVIDERS)[number];

export function isTargetProvider(v: string): v is TargetProviderName {
  return (TARGET_PROVIDERS as readonly string[]).includes(v);
}

/** One selectable delivery target. `config` is exactly what PATCH will store. */
export interface IntegrationTarget {
  id: string;
  label: string;
  config: Record<string, string>;
}

export class TargetsFetchError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'TargetsFetchError';
  }
}

const MAX_BODY_BYTES = 1024 * 1024;
const TIMEOUT_MS = 10_000;
const MAX_TARGETS = 200;

const nonEmpty = z.string().trim().min(1).max(200);

/** Strict per-provider config accepted by PATCH /integrations/:provider. */
export const TARGET_CONFIG_SCHEMAS = {
  github: z.object({
    owner: z.string().trim().regex(/^[A-Za-z0-9._-]{1,100}$/),
    repo: z.string().trim().regex(/^[A-Za-z0-9._-]{1,100}$/),
  }).strict(),
  linear: z.object({ teamId: nonEmpty }).strict(),
  jira: z.object({
    cloudId: nonEmpty,
    projectKey: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]{0,49}$/),
    issueType: nonEmpty.optional(),
    siteUrl: z.string().url().max(300).refine((u) => u.startsWith('https://'), 'siteUrl must be https').optional(),
  }).strict(),
  clickup: z.object({ listId: z.string().trim().regex(/^[A-Za-z0-9_-]{1,100}$/) }).strict(),
  asana: z.object({
    projectGid: z.string().trim().regex(/^[0-9]{1,40}$/),
    workspaceGid: z.string().trim().regex(/^[0-9]{1,40}$/).optional(),
  }).strict(),
} as const;

/** Config keys that must be present for delivery to work (mirrors the adapters). */
export const REQUIRED_CONFIG_KEYS: Record<TargetProviderName, string[]> = {
  github: ['owner', 'repo'],
  linear: ['teamId'],
  jira: ['cloudId', 'projectKey'],
  clickup: ['listId'],
  asana: ['projectGid'],
};

interface Ctx {
  token: string;
  doFetch: typeof defaultSafeFetch;
  egress: EgressGuardOptions;
}

export interface ListTargetsOptions {
  safeFetch?: typeof defaultSafeFetch;
  egress?: EgressGuardOptions;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function str(v: unknown): string | undefined {
  if (typeof v === 'string' && v) return v;
  if (typeof v === 'number') return String(v);
  return undefined;
}

async function call(ctx: Ctx, url: string, init: { method?: string; headers: Record<string, string>; body?: string }): Promise<unknown> {
  let res;
  try {
    res = await ctx.doFetch(
      url,
      { ...init, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) },
      ctx.egress,
    );
  } catch {
    throw new TargetsFetchError('Could not reach the provider.');
  }
  const { text, truncated } = await readBodyCapped(res as never, MAX_BODY_BYTES);
  if (!res.ok) {
    throw new TargetsFetchError(
      res.status === 401 || res.status === 403
        ? 'The provider rejected the stored token. Reconnect the integration.'
        : `The provider responded with HTTP ${res.status}.`,
      res.status,
    );
  }
  if (truncated) throw new TargetsFetchError('Provider response was too large.');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new TargetsFetchError('Provider response was not valid JSON.');
  }
}

async function jiraTargets(ctx: Ctx): Promise<IntegrationTarget[]> {
  const headers = { Authorization: `Bearer ${ctx.token}`, Accept: 'application/json' };
  const sites = arr(await call(ctx, 'https://api.atlassian.com/oauth/token/accessible-resources', { headers }))
    .map(obj)
    .filter((s) => str(s.id))
    .slice(0, 5);
  const out: IntegrationTarget[] = [];
  for (const site of sites) {
    const cloudId = str(site.id)!;
    const siteName = str(site.name) ?? cloudId;
    const siteUrl = str(site.url);
    const body = obj(await call(
      ctx,
      `https://api.atlassian.com/ex/jira/${encodeURIComponent(cloudId)}/rest/api/3/project/search?maxResults=50`,
      { headers },
    ));
    for (const p of arr(body.values).map(obj)) {
      const key = str(p.key);
      if (!key) continue;
      out.push({
        id: `${cloudId}:${key}`,
        label: `${siteName} / ${key} — ${str(p.name) ?? key}`,
        config: { cloudId, projectKey: key, ...(siteUrl?.startsWith('https://') ? { siteUrl } : {}) },
      });
    }
  }
  return out;
}

async function linearTargets(ctx: Ctx): Promise<IntegrationTarget[]> {
  const auth = ctx.token.startsWith('lin_api_') ? ctx.token : `Bearer ${ctx.token}`;
  const body = obj(await call(ctx, 'https://api.linear.app/graphql', {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '{ teams { nodes { id name key } } }' }),
  }));
  if (arr(body.errors).length > 0) throw new TargetsFetchError('Linear rejected the request.');
  const nodes = arr(obj(obj(body.data).teams).nodes).map(obj);
  return nodes.flatMap((t) => {
    const id = str(t.id);
    if (!id) return [];
    const key = str(t.key);
    return [{ id, label: `${str(t.name) ?? id}${key ? ` (${key})` : ''}`, config: { teamId: id } }];
  });
}

async function githubTargets(ctx: Ctx): Promise<IntegrationTarget[]> {
  const list = arr(await call(ctx, 'https://api.github.com/user/repos?per_page=100&sort=updated', {
    headers: {
      Authorization: `Bearer ${ctx.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Pinpoint',
    },
  })).map(obj);
  return list.flatMap((r) => {
    const name = str(r.name);
    const owner = str(obj(r.owner).login);
    if (!name || !owner || r.has_issues === false) return [];
    return [{ id: `${owner}/${name}`, label: `${owner}/${name}`, config: { owner, repo: name } }];
  });
}

async function clickupTargets(ctx: Ctx): Promise<IntegrationTarget[]> {
  // ClickUp sends the token without a Bearer prefix.
  const headers = { Authorization: ctx.token, Accept: 'application/json' };
  const teams = arr(obj(await call(ctx, 'https://api.clickup.com/api/v2/team', { headers })).teams).map(obj).slice(0, 3);
  const out: IntegrationTarget[] = [];
  for (const team of teams) {
    const teamId = str(team.id);
    if (!teamId) continue;
    const spaces = arr(obj(await call(
      ctx,
      `https://api.clickup.com/api/v2/team/${encodeURIComponent(teamId)}/space?archived=false`,
      { headers },
    )).spaces).map(obj).slice(0, 10);
    const perSpace = await Promise.all(spaces.map(async (space) => {
      const spaceId = str(space.id);
      if (!spaceId) return [] as IntegrationTarget[];
      const lists = arr(obj(await call(
        ctx,
        `https://api.clickup.com/api/v2/space/${encodeURIComponent(spaceId)}/list?archived=false`,
        { headers },
      )).lists).map(obj);
      return lists.flatMap((l) => {
        const listId = str(l.id);
        if (!listId) return [];
        return [{
          id: listId,
          label: `${str(team.name) ?? teamId} / ${str(space.name) ?? spaceId} / ${str(l.name) ?? listId}`,
          config: { listId },
        }];
      });
    }));
    for (const s of perSpace) out.push(...s);
  }
  return out;
}

async function asanaTargets(ctx: Ctx): Promise<IntegrationTarget[]> {
  const headers = { Authorization: `Bearer ${ctx.token}`, Accept: 'application/json' };
  const workspaces = arr(obj(await call(ctx, 'https://app.asana.com/api/1.0/workspaces?limit=20', { headers })).data)
    .map(obj)
    .slice(0, 5);
  const out: IntegrationTarget[] = [];
  for (const ws of workspaces) {
    const wsGid = str(ws.gid);
    if (!wsGid) continue;
    const projects = arr(obj(await call(
      ctx,
      `https://app.asana.com/api/1.0/projects?workspace=${encodeURIComponent(wsGid)}&archived=false&limit=100`,
      { headers },
    )).data).map(obj);
    for (const p of projects) {
      const gid = str(p.gid);
      if (!gid) continue;
      out.push({
        id: gid,
        label: `${str(ws.name) ?? wsGid} / ${str(p.name) ?? gid}`,
        config: { projectGid: gid, workspaceGid: wsGid },
      });
    }
  }
  return out;
}

/** List the delivery targets reachable with `token`. Throws `TargetsFetchError`. */
export async function listTargets(
  provider: TargetProviderName,
  token: string,
  opts: ListTargetsOptions = {},
): Promise<IntegrationTarget[]> {
  const ctx: Ctx = { token, doFetch: opts.safeFetch ?? defaultSafeFetch, egress: opts.egress ?? {} };
  const impl = { jira: jiraTargets, linear: linearTargets, github: githubTargets, clickup: clickupTargets, asana: asanaTargets }[provider];
  return (await impl(ctx)).slice(0, MAX_TARGETS);
}

/**
 * Jira only: the single accessible site, if exactly one, so the callback can
 * store `cloudId` (+ `siteUrl`) without asking. Best effort: never throws.
 */
export async function resolveSingleJiraSite(
  token: string,
  opts: ListTargetsOptions = {},
): Promise<{ cloudId: string; siteUrl?: string } | null> {
  const ctx: Ctx = { token, doFetch: opts.safeFetch ?? defaultSafeFetch, egress: opts.egress ?? {} };
  try {
    const sites = arr(await call(ctx, 'https://api.atlassian.com/oauth/token/accessible-resources', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })).map(obj);
    if (sites.length !== 1) return null;
    const cloudId = str(sites[0]!.id);
    if (!cloudId) return null;
    const siteUrl = str(sites[0]!.url);
    return { cloudId, ...(siteUrl?.startsWith('https://') ? { siteUrl } : {}) };
  } catch {
    return null;
  }
}
