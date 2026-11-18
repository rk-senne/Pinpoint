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

describe('SocketIoEventBus', () => {
  it.each([
    ['annotation.status_changed', { id: 'a1', projectId: 'p1', status: 'resolved', previousStatus: 'active' }],
    ['annotation.updated', { id: 'a1', body: 'edited' }],
    ['annotation.created', { id: 'a1' }],
    ['comment.created', { comment: { id: 'c1' }, annotationId: 'a1', projectId: 'p1' }],
  ])('emits %s once, under its dotted name, with the untouched payload', (type, payload) => {
    const { io, emitted } = fakeIo();
    new SocketIoEventBus(io).emit({ type, room: 'project:p1', payload });
    expect(emitted).toEqual([{ room: 'project:p1', name: type, payload }]);
    expect(emitted[0]!.payload).toBe(payload);
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
