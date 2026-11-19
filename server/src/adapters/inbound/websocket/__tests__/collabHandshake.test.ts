// Handshake authentication for the /collab namespace: bearer in
// `auth.token`, or the HttpOnly `fl_session` cookie — the latter ONLY from
// a trusted (dashboard) Origin. A WebSocket upgrade carries cookies but is
// not covered by CORS, so accepting the cookie from any origin would let
// any website open an authenticated socket as the visiting user (CSWSH).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { installCollabGateway } from '../collab.gateway.js';
import type { TokenIssuer } from '../../../../domain/auth/ports/TokenIssuer.js';

const DASHBOARD = 'https://app.pinpoint.test';
const tokenIssuer: TokenIssuer = {
  sign: () => 'unused',
  verify: (t: string) => {
    if (t !== 'good-jwt') throw new Error('bad');
    return { userId: '00000000-0000-4000-8000-000000000001', email: 'a@b.c', orgId: '00000000-0000-4000-8000-0000000000a1', role: 'owner', tokenVersion: 0 };
  },
} as unknown as TokenIssuer;

let http: HttpServer;
let url: string;
const clients: ClientSocket[] = [];

beforeEach(async () => {
  http = createServer();
  const io = new Server(http);
  // Session validation hits `users as u` (token_version + membership role).
  const db = ((table: string) => {
    const b: Record<string, unknown> = {};
    const chain = () => b;
    b.leftJoin = chain;
    b.where = chain;
    b.first = () => Promise.resolve(table === 'users as u' ? { token_version: 0, name: 'Ann', role: 'owner' } : undefined);
    return b;
  }) as never;
  installCollabGateway(io, { tokenIssuer, db, trustedCookieOrigins: [DASHBOARD] });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/collab`;
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await new Promise<void>((r) => http.close(() => r()));
});

function connect(opts: { token?: string; origin?: string; cookie?: string }): Promise<'connected' | string> {
  const c = ioClient(url, {
    transports: ['websocket'],
    reconnection: false,
    ...(opts.token ? { auth: { token: opts.token } } : {}),
    extraHeaders: {
      ...(opts.origin ? { Origin: opts.origin } : {}),
      ...(opts.cookie ? { Cookie: opts.cookie } : {}),
    },
  });
  clients.push(c);
  return new Promise((resolve) => {
    c.on('connect', () => resolve('connected'));
    c.on('connect_error', (e) => resolve(e.message));
  });
}

describe('collab gateway handshake auth', () => {
  it('accepts a bearer token from any origin (extension / fresh login)', async () => {
    await expect(connect({ token: 'good-jwt', origin: 'https://customer.example' })).resolves.toBe('connected');
  });

  it('accepts the fl_session cookie from the trusted dashboard origin', async () => {
    await expect(connect({ origin: DASHBOARD, cookie: 'fl_session=good-jwt; fl_csrf=x' })).resolves.toBe('connected');
  });

  it('REJECTS the fl_session cookie from any other origin (CSWSH)', async () => {
    await expect(connect({ origin: 'https://evil.example', cookie: 'fl_session=good-jwt' })).resolves.toBe(
      'Authentication required',
    );
  });

  it('rejects a cookie handshake with no Origin header', async () => {
    await expect(connect({ cookie: 'fl_session=good-jwt' })).resolves.toBe('Authentication required');
  });

  it('rejects an invalid cookie token even from the trusted origin', async () => {
    await expect(connect({ origin: DASHBOARD, cookie: 'fl_session=forged' })).resolves.toBe('Invalid or expired token');
  });
});
