/**
 * annotationDiagnostics.test.ts — Mission C2 + C3 (server domain). Confirms
 * the additive `consoleLogs` / `jsErrors` (C2) and `sessionReplay` (C3)
 * fields round-trip through the in-memory AnnotationRepo fake exactly as the
 * Postgres adapter maps the sibling JSONB columns.
 */

import { describe, expect, it } from 'vitest';

import { FakeAnnotationRepo } from '../../../__tests__/fakes/FakeAnnotationRepo.js';
import type {
  ConsoleLogEntry,
  JsErrorEntry,
  NewAnnotation,
  ReplayEvent,
} from '../Annotation.js';

const clock = { now: () => new Date('2026-11-13T12:00:00.000Z') };

function baseInput(): NewAnnotation {
  return {
    projectId: 'p1',
    pageId: 'pg1',
    type: 'note',
    severity: 'critical',
    status: 'active',
    body: 'bug',
    authorId: 'u1',
    target: {
      cssSelector: 'body',
      xpath: '/html/body',
      pageX: 0,
      pageY: 0,
      tagName: 'BODY',
      textSnippet: '',
    },
    environment: {
      browserFamily: 'Chrome',
      browserVersion: '120',
      osFamily: 'macOS',
      osVersion: '14',
      deviceType: 'desktop',
      userAgentRaw: 'UA',
    },
    pinNumber: 1,
  };
}

describe('AnnotationRepo diagnostics + session replay round-trip', () => {
  it('persists consoleLogs, jsErrors and sessionReplay', async () => {
    const repo = new FakeAnnotationRepo(clock);
    const consoleLogs: ConsoleLogEntry[] = [
      { level: 'error', message: 'boom', timestamp: '2026-11-13T12:00:00.000Z' },
    ];
    const jsErrors: JsErrorEntry[] = [
      {
        kind: 'unhandledrejection',
        message: 'nope',
        timestamp: '2026-11-13T12:00:00.000Z',
      },
    ];
    const sessionReplay: ReplayEvent[] = [
      { type: 'click', timestamp: 1, data: { x: 1, y: 2 } },
    ];

    const created = await repo.insert({
      ...baseInput(),
      consoleLogs,
      jsErrors,
      sessionReplay,
    });

    expect(created.consoleLogs).toEqual(consoleLogs);
    expect(created.jsErrors).toEqual(jsErrors);
    expect(created.sessionReplay).toEqual(sessionReplay);

    const fetched = await repo.findById(created.id);
    expect(fetched?.consoleLogs).toEqual(consoleLogs);
    expect(fetched?.jsErrors).toEqual(jsErrors);
    expect(fetched?.sessionReplay).toEqual(sessionReplay);
  });

  it('preserves explicit null distinct from undefined', async () => {
    const repo = new FakeAnnotationRepo(clock);
    const created = await repo.insert({
      ...baseInput(),
      consoleLogs: null,
      jsErrors: null,
      sessionReplay: null,
    });
    expect(created.consoleLogs).toBeNull();
    expect(created.jsErrors).toBeNull();
    expect(created.sessionReplay).toBeNull();
  });

  it('omits the fields when not supplied', async () => {
    const repo = new FakeAnnotationRepo(clock);
    const created = await repo.insert(baseInput());
    expect(created.consoleLogs).toBeUndefined();
    expect(created.jsErrors).toBeUndefined();
    expect(created.sessionReplay).toBeUndefined();
  });
});
