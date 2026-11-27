// Shared supertest client helper (flake fix).
//
// ROOT CAUSE of the intermittent "Parse Error: Expected HTTP/",
// "Test timed out in 5000ms", and "ETIMEDOUT: Operation timed out"
// failures seen in supertest-based suites (e.g. authRateLimit.test.ts,
// annotations.premium.test.ts, csrf.test.ts, billing.routes.test.ts)
// under parallel vitest load:
//
//   `request(app)` — where `app` is a *bare* Express app rather than a
//   listening `http.Server` — makes supertest spin up a throwaway
//   server with `app.listen(0)` and immediately connect a client to
//   `127.0.0.1:<ephemeral-port>` for that single request
//   (supertest/lib/test.js `serverAddress`). `listen(0)` returns the
//   port, but the listening socket is not guaranteed to be *accepting*
//   yet. Under the forks pool the machine is oversubscribed (one fork
//   per core plus jsdom transform load), so the fork can be descheduled
//   between `listen` and the client `connect`. On macOS a SYN to a
//   not-yet-accepting ephemeral listener is occasionally dropped and the
//   connect then stalls until a timeout fires — surfacing as a hang, a
//   late reply, or framing garbage read from a half-open socket
//   ("Parse Error: Expected HTTP/").
//
//   Proven empirically: the failure reproduces even with
//   `--no-file-parallelism` (one server alive at a time) and is NOT
//   fixed by raising `testTimeout` (the OS raises `ETIMEDOUT` — the
//   connect genuinely never completes). superagent already defaults to
//   `agent: false` (no socket pooling), so keep-alive reuse is not it.
//
// FIX (not a retry): bind each app to ONE persistent `http.Server`,
// started once and awaited to the `listening` state BEFORE any client
// connects, and reuse it for every request against that app. This
// removes the per-request `listen(0)` churn and guarantees the client
// only ever connects to a socket that is already fully accepting, so
// the listen/connect race cannot occur. Servers are cached per app and
// closed automatically via an `afterAll` hook registered on first use.
//
// Usage — a drop-in replacement for `request(app)`:
//
//   import { request } from '../../__tests__/supertestClient.js';
//   const res = await request(app).post('/x').send({ ... });

import http from 'node:http';
import { afterAll } from 'vitest';
import supertest from 'supertest';
import type { Test } from 'supertest';
import type { Express } from 'express';

type AppOrServer = Express | http.Server;

interface Entry {
  server: http.Server;
  /** Resolves once the server has emitted `listening`. */
  ready: Promise<void>;
}

const entries = new Map<AppOrServer, Entry>();
let cleanupRegistered = false;

function registerCleanupOnce(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  afterAll(async () => {
    const pending = [...entries.values()].map(
      ({ server }) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    );
    entries.clear();
    cleanupRegistered = false;
    await Promise.all(pending);
  });
}

function entryFor(app: AppOrServer): Entry {
  const cached = entries.get(app);
  if (cached) return cached;

  const server = app instanceof http.Server ? app : http.createServer(app);
  const ready = new Promise<void>((resolve, reject) => {
    if (server.listening) {
      resolve();
      return;
    }
    server.once('listening', () => resolve());
    server.once('error', reject);
    // Bind to loopback explicitly so the client's connect to 127.0.0.1
    // always targets this listener.
    server.listen(0, '127.0.0.1');
  });

  const entry: Entry = { server, ready };
  entries.set(app, entry);
  registerCleanupOnce();
  return entry;
}

/**
 * A lazy, awaitable supertest `Test`. All synchronous supertest setters
 * (`.set`, `.send`, `.query`, `.expect`, `.auth`, `.type`, `.field`,
 * `.attach`, …) are recorded and replayed against the real `Test` only
 * once the underlying server is confirmed listening. The network I/O is
 * therefore never issued against a half-ready socket.
 */
function lazyTest(entry: Entry, method: HttpVerb, url: string): Test {
  // The deferred factory builds the real supertest Test once the server
  // is listening, then replays queued setter calls in order.
  const queued: Array<{ name: string; args: unknown[] }> = [];

  const build = async (): Promise<Test> => {
    await entry.ready;
    let test = supertest(entry.server)[method](url) as Test;
    for (const call of queued) {
      // Each supertest setter returns the Test for chaining.
      test = (test as unknown as Record<string, (...a: unknown[]) => Test>)[call.name](
        ...call.args,
      );
    }
    return test;
  };

  const proxy = new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop === 'then') {
          // Make the proxy awaitable: resolve the built Test, which is
          // itself a thenable that performs the request.
          return (onFulfilled: unknown, onRejected: unknown) =>
            build().then(
              onFulfilled as never,
              onRejected as never,
            );
        }
        if (prop === 'catch') {
          return (onRejected: unknown) => build().then((t) => t).catch(onRejected as never);
        }
        if (prop === 'end') {
          return (cb: (err: unknown, res: unknown) => void) => {
            build().then((t) => t.end(cb), (err) => cb(err, undefined));
            return proxy;
          };
        }
        // Any other property is a chainable setter: record and return proxy.
        return (...args: unknown[]) => {
          queued.push({ name: prop, args });
          return proxy;
        };
      },
    },
  );

  return proxy as unknown as Test;
}

type HttpVerb = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options';

class LazyAgent {
  constructor(private readonly entry: Entry) {}
  get(url: string): Test {
    return lazyTest(this.entry, 'get', url);
  }
  post(url: string): Test {
    return lazyTest(this.entry, 'post', url);
  }
  put(url: string): Test {
    return lazyTest(this.entry, 'put', url);
  }
  patch(url: string): Test {
    return lazyTest(this.entry, 'patch', url);
  }
  delete(url: string): Test {
    return lazyTest(this.entry, 'delete', url);
  }
  head(url: string): Test {
    return lazyTest(this.entry, 'head', url);
  }
  options(url: string): Test {
    return lazyTest(this.entry, 'options', url);
  }
}

/**
 * Drop-in replacement for supertest's `request(app)`. Returns an agent
 * bound to a stable, already-listening server for `app`, eliminating the
 * per-request `listen(0)` race that causes the parallel-load flake. The
 * usual chainable API (`.get/.post/.put/.patch/.delete`, `.send`, `.set`,
 * `.expect`, `await`, `.end`, …) is preserved.
 */
export function request(app: AppOrServer): LazyAgent {
  return new LazyAgent(entryFor(app));
}

export default request;
