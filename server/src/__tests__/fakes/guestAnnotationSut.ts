// Test helper: a REAL `CreateGuestAnnotation` wired over the in-memory fakes,
// so route tests exercise the actual guest-create path (page resolve/create,
// atomic pin allocation, author_id NULL + is_guest, realtime broadcast)
// instead of a hand-rolled repo insert.

import { CreateGuestAnnotation } from '../../domain/annotation/usecases/createAnnotation.js';
import {
  FakeAnnotationRepo,
  FakeClock,
  FakeEventBus,
  FakePageRepo,
  FakeProjectPinSequence,
  FakeProjectRepo,
  FakeTeamMemberRepo,
} from './index.js';

export async function buildGuestAnnotationSut() {
  const clock = new FakeClock(new Date('2026-11-13T12:00:00Z'));
  const teamMemberRepo = new FakeTeamMemberRepo({ clock });
  const projectRepo = new FakeProjectRepo({ clock, teamMemberRepo });
  const pageRepo = new FakePageRepo(clock);
  const annotationRepo = new FakeAnnotationRepo(clock);
  const pinSequence = new FakeProjectPinSequence();
  const eventBus = new FakeEventBus();

  const project = await projectRepo.insert({
    name: 'Guest target',
    urls: ['https://example.com'],
    ownerId: 'owner-1',
  });

  const createGuestAnnotation = new CreateGuestAnnotation({
    annotationRepo,
    projectRepo,
    pageRepo,
    teamMemberRepo,
    pinSequence,
    runInTransaction: async (fn) => fn({}),
    clock,
    eventBus,
  });

  return { createGuestAnnotation, projectId: project.id, annotationRepo, pageRepo, eventBus };
}
