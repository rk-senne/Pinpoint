/**
 * LiveCursors — real-time cursor sharing for teammates reviewing the
 * same page simultaneously. Extension sends throttled cursor positions;
 * Socket.IO broadcasts to the project room.
 *
 * Extension side: call startCursorBroadcast() when collab mode is active.
 * Dashboard/extension side: listen for 'cursor:move' events to render
 * remote cursors.
 */

export interface CursorPosition {
  userId: string;
  email: string;
  x: number;
  y: number;
  pageUrl: string;
}

const THROTTLE_MS = 100;

export function startCursorBroadcast(
  socket: { emit: (event: string, data: unknown) => void },
  userInfo: { userId: string; email: string },
): () => void {
  let lastEmit = 0;

  const handler = (e: MouseEvent) => {
    const now = Date.now();
    if (now - lastEmit < THROTTLE_MS) return;
    lastEmit = now;
    socket.emit('cursor:move', {
      userId: userInfo.userId,
      email: userInfo.email,
      x: e.clientX + window.scrollX,
      y: e.clientY + window.scrollY,
      pageUrl: window.location.href,
    });
  };

  document.addEventListener('mousemove', handler);
  return () => document.removeEventListener('mousemove', handler);
}

/**
 * Render a remote cursor on the page. Returns a cleanup function.
 */
export function renderRemoteCursor(cursor: CursorPosition): () => void {
  const el = document.createElement('div');
  el.className = 'pinpoint-remote-cursor';
  el.setAttribute('data-user', cursor.userId);
  el.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" style="color:#4f46e5">
      <path d="M0 0l6.5 16 2.5-6.5L16 6.5z"/>
    </svg>
    <span style="background:#4f46e5;color:#fff;font-size:10px;padding:1px 4px;border-radius:3px;margin-left:4px;white-space:nowrap;">${cursor.email.split('@')[0]}</span>
  `;
  Object.assign(el.style, {
    position: 'absolute',
    left: `${cursor.x}px`,
    top: `${cursor.y}px`,
    pointerEvents: 'none',
    zIndex: '999999',
    transition: 'left 0.1s, top 0.1s',
  });
  document.body.appendChild(el);
  return () => el.remove();
}
