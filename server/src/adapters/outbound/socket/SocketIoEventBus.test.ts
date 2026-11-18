import { describe, it, expect, vi } from 'vitest';
import type { Server } from 'socket.io';

import { SocketIoEventBus, SESSION_REVOKED_EVENT } from './SocketIoEventBus.js';

function fakeIo() {
  const emitted: Array<{ room: string | null; name: string; payload: unknown }> = [];
  const target = (room: string | null) => ({
    emit: (name: string, payload: unknown) => emitted.push({ room, name, payload }),
  });
  const ns = { to: (room: string) => target(room), emit: target(null).emit };
  return { io: { of: () => ns } as unknown as Server, emitted };
}

describe('SocketIoEventBus client aliases', () => {
  it('emits status_changed under the dotted name and the colon name both clients handle', () => {
    const { io, emitted } = fakeIo();
    new SocketIoEventBus(io).emit({
      type: 'annotation.status_changed',
      room: 'project:p1',
      payload: { id: 'a1', projectId: 'p1', status: 'resolved', previousStatus: 'active' },
    });
    expect(emitted.map((e) => e.name)).toEqual(['annotation.status_changed', 'annotation:status']);
    expect(emitted.every((e) => e.room === 'project:p1')).toBe(true);
    expect(emitted[1]!.payload).toEqual({ id: 'a1', status: 'resolved', projectId: 'p1' });
  });

  it('emits annotation.updated as annotation:updated with the full annotation', () => {
    const { io, emitted } = fakeIo();
    const payload = { id: 'a1', body: 'edited' };
    new SocketIoEventBus(io).emit({ type: 'annotation.updated', room: 'project:p1', payload });
    expect(emitted.map((e) => e.name)).toEqual(['annotation.updated', 'annotation:updated']);
    expect(emitted[1]!.payload).toBe(payload);
  });

  it('unwraps comment.created for the colon-named listener', () => {
    const { io, emitted } = fakeIo();
    new SocketIoEventBus(io).emit({
      type: 'comment.created',
      room: 'project:p1',
      payload: { comment: { id: 'c1' }, annotationId: 'a1', projectId: 'p1' },
    });
    expect(emitted.find((e) => e.name === 'comment:created')!.payload).toEqual({ id: 'c1' });
  });

  it('drops room-less emits instead of broadcasting namespace-wide (PP-01)', () => {
    const { io, emitted } = fakeIo();
    new SocketIoEventBus(io).emit({ type: 'org.invitation_created', payload: { email: 'x@y.z' } });
    expect(emitted).toEqual([]);
  });

  it('delivers unmapped events to their room untouched', () => {
    const { io, emitted } = fakeIo();
    new SocketIoEventBus(io).emit({ type: 'notification.created', room: 'user:u1', payload: { id: 'n' } });
    expect(emitted).toEqual([{ room: 'user:u1', name: 'notification.created', payload: { id: 'n' } }]);
  });
});

describe('session.revoked control event (PP-02)', () => {
  it('disconnects the sockets of the room instead of emitting a payload', () => {
    const disconnectSockets = vi.fn();
    const inFn = vi.fn(() => ({ disconnectSockets }));
    const emit = vi.fn();
    const io = { of: () => ({ in: inFn, to: () => ({ emit }) }) } as unknown as Server;
    new SocketIoEventBus(io).emit({ type: SESSION_REVOKED_EVENT, room: 'user:u1', payload: {} });
    expect(inFn).toHaveBeenCalledWith('user:u1');
    expect(disconnectSockets).toHaveBeenCalledWith(true);
    expect(emit).not.toHaveBeenCalled();
  });
});
