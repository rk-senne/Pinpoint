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

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'currentColor');
  svg.style.color = '#4f46e5';
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M0 0l6.5 16 2.5-6.5L16 6.5z');
  svg.appendChild(path);

  const label = document.createElement('span');
  label.textContent = cursor.email.split('@')[0];
  Object.assign(label.style, {
    background: '#4f46e5',
    color: '#fff',
    fontSize: '10px',
    padding: '1px 4px',
    borderRadius: '3px',
    marginLeft: '4px',
    whiteSpace: 'nowrap',
  });

  el.appendChild(svg);
  el.appendChild(label);

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
