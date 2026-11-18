import { io, Socket } from 'socket.io-client';
import { getToken } from './auth';
import type { Annotation, Comment } from '@pinpoint/shared';

/** Payload of `annotation.status_changed`: the full annotation plus change metadata. */
export type AnnotationStatusChange = Annotation & {
  previousStatus?: string;
  changedBy?: string;
  pageUrl?: string | null;
};

/** Payload of `comment.created`: the comment wrapped with routing ids. */
export interface CommentCreatedEvent {
  comment: Comment;
  annotationId: string;
  projectId: string;
}

/**
 * Canonical realtime events. Domain events use dotted names (the same
 * vocabulary as webhooks); `annotation:viewers` / `presence:update` are
 * socket-only presence signals and keep their colon names.
 */
export interface SocketEvents {
  'annotation.created': (annotation: Annotation) => void;
  'annotation.updated': (annotation: Annotation) => void;
  'annotation.status_changed': (annotation: AnnotationStatusChange) => void;
  'comment.created': (event: CommentCreatedEvent) => void;
  'annotation:viewers': (data: { id: string; userIds: string[] }) => void;
  'presence:update': (data: { userId: string; online: boolean }) => void;
  'notification.created': (notification: { id: string; title: string; body: string; read: boolean; createdAt: string }) => void;
}

/**
 * @deprecated Legacy colon event names with their pre-dotted payload shapes.
 * They are served by subscribing to the canonical dotted event and adapting
 * the payload, so existing call sites keep working. Remove once
 * `pages/ProjectView.ts` (the last caller of `annotation:created|updated|status`)
 * subscribes to the dotted names.
 */
export interface LegacySocketEvents {
  'annotation:created': (annotation: Annotation) => void;
  'annotation:updated': (annotation: Annotation) => void;
  'annotation:status': (data: { id: string; status: string }) => void;
  'comment:created': (comment: Comment) => void;
}

const LEGACY_EVENT_MAP: Record<
  keyof LegacySocketEvents,
  { event: keyof SocketEvents; adapt: (payload: any) => unknown }
> = {
  'annotation:created': { event: 'annotation.created', adapt: (p) => p },
  'annotation:updated': { event: 'annotation.updated', adapt: (p) => p },
  'annotation:status': {
    event: 'annotation.status_changed',
    adapt: (p) => ({ id: p?.id, status: p?.status }),
  },
  'comment:created': {
    event: 'comment.created',
    adapt: (p) => (p && typeof p === 'object' && 'comment' in p ? p.comment : p),
  },
};

let socket: Socket | null = null;
let currentProjectId: string | null = null;
let currentOpenAnnotationId: string | null = null;
let reconnectListeners: Array<(reconnecting: boolean) => void> = [];

function getBaseUrl(): string {
  // In dev, the API server runs on a different port
  return import.meta.env.VITE_API_URL || '';
}

/**
 * Get or create the Socket.IO client connection to the /collab namespace.
 */
function getSocket(): Socket {
  if (socket && socket.connected) return socket;

  // After a hard refresh the in-memory bearer is gone; the HttpOnly
  // `fl_session` cookie still rides on the same-origin handshake and the
  // server accepts it from the dashboard origin. So connect either way.
  const token = getToken();

  socket = io(`${getBaseUrl()}/collab`, {
    ...(token ? { auth: { token } } : {}),
    withCredentials: true,
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: Infinity,
  });

  socket.on('disconnect', () => {
    notifyReconnectListeners(true);
  });

  socket.on('connect', () => {
    notifyReconnectListeners(false);
    // Re-join the current project room on reconnect
    if (currentProjectId && socket) {
      socket.emit('join', { projectId: currentProjectId });
    }
    // Re-announce presence on the currently open annotation, if any.
    // The server's in-memory presence map is wiped on disconnect, so we
    // re-emit `annotation:open` so co-viewers see us reappear without the
    // user having to reopen the detail panel (Req 6.6).
    if (currentOpenAnnotationId && socket) {
      socket.emit('annotation:open', { id: currentOpenAnnotationId });
    }
  });

  socket.on('connect_error', () => {
    notifyReconnectListeners(true);
  });

  return socket;
}

function notifyReconnectListeners(reconnecting: boolean) {
  for (const listener of reconnectListeners) {
    listener(reconnecting);
  }
}

/**
 * Subscribe to reconnection state changes.
 * Returns an unsubscribe function.
 */
export function onReconnectStateChange(listener: (reconnecting: boolean) => void): () => void {
  reconnectListeners.push(listener);
  return () => {
    reconnectListeners = reconnectListeners.filter((l) => l !== listener);
  };
}

/**
 * Join a project room to receive real-time updates.
 */
export function joinProject(projectId: string): void {
  const s = getSocket();
  // Leave previous room if different
  if (currentProjectId && currentProjectId !== projectId) {
    s.emit('leave', { projectId: currentProjectId });
  }
  currentProjectId = projectId;
  s.emit('join', { projectId });
}

/**
 * Leave the current project room.
 */
export function leaveProject(): void {
  if (currentProjectId && socket) {
    socket.emit('leave', { projectId: currentProjectId });
    currentProjectId = null;
  }
}

/**
 * Announce that the local user has opened an annotation. The server adds
 * the user to the annotation's viewer set and broadcasts the resulting
 * `annotation:viewers` payload to the annotation's room (Req 6.6, 6.7).
 */
export function emitAnnotationOpen(annotationId: string): void {
  if (!annotationId) return;
  // If a different annotation was previously open, close it first so the
  // server's presence map stays consistent.
  if (currentOpenAnnotationId && currentOpenAnnotationId !== annotationId) {
    emitAnnotationClose(currentOpenAnnotationId);
  }
  currentOpenAnnotationId = annotationId;
  try {
    const s = getSocket();
    s.emit('annotation:open', { id: annotationId });
  } catch {
    // Not authenticated or socket error — ignore. Presence is best-effort
    // and the REST data is unaffected.
  }
}

/**
 * Announce that the local user has closed the annotation detail panel.
 */
export function emitAnnotationClose(annotationId: string): void {
  if (!annotationId) return;
  if (currentOpenAnnotationId === annotationId) {
    currentOpenAnnotationId = null;
  }
  if (socket && socket.connected) {
    socket.emit('annotation:close', { id: annotationId });
  }
}

/**
 * Subscribe to a WebSocket event. Returns an unsubscribe function.
 */
export function onSocketEvent<K extends keyof SocketEvents>(
  event: K,
  handler: SocketEvents[K],
): () => void;
/** @deprecated Colon event names — use the dotted equivalents (see `LegacySocketEvents`). */
export function onSocketEvent<K extends keyof LegacySocketEvents>(
  event: K,
  handler: LegacySocketEvents[K],
): () => void;
export function onSocketEvent(event: string, handler: (payload: any) => void): () => void {
  const s = getSocket();
  const legacy = LEGACY_EVENT_MAP[event as keyof LegacySocketEvents];
  const wire = legacy ? legacy.event : event;
  const listener = legacy ? (payload: unknown) => handler(legacy.adapt(payload)) : handler;
  s.on(wire, listener);
  return () => {
    s.off(wire, listener);
  };
}

/**
 * Disconnect the socket entirely (e.g., on logout).
 */
export function disconnectSocket(): void {
  if (socket) {
    if (currentOpenAnnotationId) {
      socket.emit('annotation:close', { id: currentOpenAnnotationId });
    }
    if (currentProjectId) {
      socket.emit('leave', { projectId: currentProjectId });
    }
    socket.disconnect();
    socket = null;
    currentProjectId = null;
    currentOpenAnnotationId = null;
    reconnectListeners = [];
  }
}
