/**
 * Local-UUID → server-id handoff for work that must target the CANONICAL
 * annotation row.
 *
 * The popover creates annotations optimistically with a client UUID and the
 * Syncer replays the queued create later (immediately when online, after
 * reconnect when offline). The server assigns its own id, so anything that
 * needs `/annotations/:id/...` right after submit — the screenshot upload —
 * used to hit `/annotations/<localUuid>/screenshot` and 404, so no annotation
 * created from the extension ever got a screenshot.
 *
 * `resolveCanonicalAnnotationId` is called from the Syncer remap adapter in
 * `content.ts`; `awaitCanonicalAnnotationId` lets the popover wait for it.
 */
const resolved = new Map<string, string>();
const waiters = new Map<string, Array<(id: string | null) => void>>();
/** Cap on remembered mappings so a long session cannot grow unbounded. */
const MAX_REMEMBERED = 200;

export function resolveCanonicalAnnotationId(localUuid: string, serverId: string): void {
  if (!localUuid || !serverId) return;
  resolved.set(localUuid, serverId);
  if (resolved.size > MAX_REMEMBERED) {
    const oldest = resolved.keys().next().value;
    if (oldest !== undefined) resolved.delete(oldest);
  }
  const pending = waiters.get(localUuid);
  if (pending) {
    waiters.delete(localUuid);
    for (const fn of pending) fn(serverId);
  }
}

/**
 * Resolve with the server id once the Syncer reconciles `localUuid`, or
 * `null` after `timeoutMs`.
 */
export function awaitCanonicalAnnotationId(
  localUuid: string,
  timeoutMs: number,
): Promise<string | null> {
  const known = resolved.get(localUuid);
  if (known) return Promise.resolve(known);
  return new Promise((resolve) => {
    let done = false;
    const finish = (id: string | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(id);
    };
    const timer = setTimeout(() => {
      const list = waiters.get(localUuid);
      if (list) {
        const rest = list.filter((fn) => fn !== finish);
        if (rest.length) waiters.set(localUuid, rest);
        else waiters.delete(localUuid);
      }
      finish(null);
    }, timeoutMs);
    const list = waiters.get(localUuid) ?? [];
    list.push(finish);
    waiters.set(localUuid, list);
  });
}

/** Test helper. */
export function __resetCanonicalAnnotationIdsForTests(): void {
  resolved.clear();
  waiters.clear();
}
