// Barrel export for the in-memory test doubles (Phase 1.5 / task 4.11.1).
//
// Each fake implements its corresponding port with deterministic behavior
// suitable for use-case unit tests. Import from this module to keep test
// setup readable:
//
//   import { FakeClock, FakeUserRepo, FakeProjectRepo } from '../../__tests__/fakes';

export { FakeAnalyticsRepo } from './FakeAnalyticsRepo.js';
export { FakeAnnotationRepo } from './FakeAnnotationRepo.js';
export { FakeAuthTokenRepo } from './FakeAuthTokenRepo.js';
export { FakeClock } from './FakeClock.js';
export { FakeCommentRepo } from './FakeCommentRepo.js';
export { FakeEventBus } from './FakeEventBus.js';
export { FakeGuidelineRepo } from './FakeGuidelineRepo.js';
export { FakeLogger } from './FakeLogger.js';
export type { FakeLogLevel, FakeLogRecord } from './FakeLogger.js';
export { FakeMailer } from './FakeMailer.js';
export { FakeMembershipRepo } from './FakeMembershipRepo.js';
export { FakeNotificationQueue } from './FakeNotificationQueue.js';
export { FakePageRepo } from './FakePageRepo.js';
export { FakePasswordHasher } from './FakePasswordHasher.js';
export { FakeProjectPinSequence } from './FakeProjectPinSequence.js';
export { FakeProjectRepo } from './FakeProjectRepo.js';
export type { FakeProjectRepoDeps } from './FakeProjectRepo.js';
export { FakeReportRenderer } from './FakeReportRenderer.js';
export { FakeScreenshotStore } from './FakeScreenshotStore.js';
export { FakeSharedLinkRepo } from './FakeSharedLinkRepo.js';
export { FakeTeamMemberRepo } from './FakeTeamMemberRepo.js';
export type { FakeTeamMemberRepoDeps } from './FakeTeamMemberRepo.js';
export { FakeTeamRepo } from './FakeTeamRepo.js';
export type { FakeTeamRepoDeps } from './FakeTeamRepo.js';
export { FakeTokenIssuer } from './FakeTokenIssuer.js';
export type { FakeTokenIssuerOptions } from './FakeTokenIssuer.js';
export { FakeUserRepo } from './FakeUserRepo.js';
