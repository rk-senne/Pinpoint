/**
 * Type-level compatibility check between server domain entities and the
 * `@pinpoint/shared` wire-shape types. The goal is to catch field-level
 * drift in CI: if a domain entity grows/loses a field without a matching
 * change in the shared package (or vice versa), this file will fail to
 * type-check under `tsc --build server`.
 *
 * Each pair is asserted in BOTH directions with `toMatchTypeOf` so that
 * widening *or* narrowing on either side is caught. A separate `enums`
 * block uses the stricter `toEqualTypeOf` to assert exact equality on
 * the closed string-literal unions (severity, status, browser family,
 * notification kind, etc.) shared between the layers.
 *
 * The `expectTypeOf` calls are runtime no-ops; the real safety net is
 * the TypeScript compiler. Vitest still discovers the file (see the
 * root `vitest.config.ts` `include` pattern) so the test surface
 * shows green/red alongside the rest of the suite.
 */

import { describe, it, expectTypeOf } from 'vitest';

import type {
  Annotation as SharedAnnotation,
  AnnotationStatus as SharedAnnotationStatus,
  AnnotationType as SharedAnnotationType,
  AuthTokenKind as SharedAuthTokenKind,
  BrowserFamily as SharedBrowserFamily,
  CapturedConsoleEntry as SharedCapturedConsoleEntry,
  CapturedNetworkEntry as SharedCapturedNetworkEntry,
  Comment as SharedComment,
  DeviceType as SharedDeviceType,
  DOMTarget as SharedDOMTarget,
  EnvironmentMetadata as SharedEnvironmentMetadata,
  Guideline as SharedGuideline,
  Notification as SharedNotification,
  NotificationPayload as SharedNotificationPayload,
  NotificationPreferences as SharedNotificationPreferences,
  OsFamily as SharedOsFamily,
  Page as SharedPage,
  Project as SharedProject,
  ProjectStatus as SharedProjectStatus,
  Severity as SharedSeverity,
  SharedLink as SharedSharedLink,
  Team as SharedTeam,
  TeamMember as SharedTeamMember,
  TeamRole as SharedTeamRole,
  User as SharedUser,
} from '@pinpoint/shared';

import type {
  Annotation as DomainAnnotation,
  AnnotationStatus as DomainAnnotationStatus,
  AnnotationType as DomainAnnotationType,
  CapturedConsoleEntry as DomainCapturedConsoleEntry,
  CapturedNetworkEntry as DomainCapturedNetworkEntry,
  Severity as DomainSeverity,
} from '../annotation/Annotation.js';
import type { DOMTarget as DomainDOMTarget } from '../annotation/DOMTarget.js';
import type {
  BrowserFamily as DomainBrowserFamily,
  DeviceType as DomainDeviceType,
  EnvironmentMetadata as DomainEnvironmentMetadata,
  OsFamily as DomainOsFamily,
} from '../annotation/EnvironmentMetadata.js';
import type { AuthTokenKind as DomainAuthTokenKind } from '../auth/AuthToken.js';
import type { Comment as DomainComment } from '../comment/Comment.js';
import type { Guideline as DomainGuideline } from '../guideline/Guideline.js';
import type {
  Notification as DomainNotification,
  NotificationKind as DomainNotificationKind,
  NotificationPayload as DomainNotificationPayload,
} from '../notification/Notification.js';
import type { Page as DomainPage } from '../project/Page.js';
import type {
  Project as DomainProject,
  ProjectStatus as DomainProjectStatus,
} from '../project/Project.js';
import type { SharedLink as DomainSharedLink } from '../sharedLink/SharedLink.js';
import type { Team as DomainTeam } from '../team/Team.js';
import type {
  TeamMember as DomainTeamMember,
  TeamRole as DomainTeamRole,
} from '../team/TeamMember.js';
import type {
  NotificationPreferences as DomainNotificationPreferences,
  User as DomainUser,
} from '../user/User.js';

/**
 * The shared package does not export a standalone `NotificationKind`; it is
 * the `kind` field of `NotificationPayload`. Pull it out so the enum
 * equality assertion below can compare the two unions directly.
 */
type SharedNotificationKind = SharedNotificationPayload['kind'];

describe('server domain ↔ @pinpoint/shared type compatibility', () => {
  it('User', () => {
    expectTypeOf<DomainUser>().toMatchTypeOf<SharedUser>();
    expectTypeOf<SharedUser>().toMatchTypeOf<DomainUser>();
  });

  it('NotificationPreferences (declared in both shared/types.ts and domain/user/User.ts)', () => {
    expectTypeOf<DomainNotificationPreferences>().toMatchTypeOf<SharedNotificationPreferences>();
    expectTypeOf<SharedNotificationPreferences>().toMatchTypeOf<DomainNotificationPreferences>();
  });

  it('Project', () => {
    expectTypeOf<DomainProject>().toMatchTypeOf<SharedProject>();
    expectTypeOf<SharedProject>().toMatchTypeOf<DomainProject>();
  });

  it('Page', () => {
    expectTypeOf<DomainPage>().toMatchTypeOf<SharedPage>();
    expectTypeOf<SharedPage>().toMatchTypeOf<DomainPage>();
  });

  it('DOMTarget', () => {
    expectTypeOf<DomainDOMTarget>().toMatchTypeOf<SharedDOMTarget>();
    expectTypeOf<SharedDOMTarget>().toMatchTypeOf<DomainDOMTarget>();
  });

  it('EnvironmentMetadata', () => {
    expectTypeOf<DomainEnvironmentMetadata>().toMatchTypeOf<SharedEnvironmentMetadata>();
    expectTypeOf<SharedEnvironmentMetadata>().toMatchTypeOf<DomainEnvironmentMetadata>();
  });

  it('CapturedConsoleEntry', () => {
    expectTypeOf<DomainCapturedConsoleEntry>().toMatchTypeOf<SharedCapturedConsoleEntry>();
    expectTypeOf<SharedCapturedConsoleEntry>().toMatchTypeOf<DomainCapturedConsoleEntry>();
  });

  it('CapturedNetworkEntry', () => {
    expectTypeOf<DomainCapturedNetworkEntry>().toMatchTypeOf<SharedCapturedNetworkEntry>();
    expectTypeOf<SharedCapturedNetworkEntry>().toMatchTypeOf<DomainCapturedNetworkEntry>();
  });

  it('Annotation', () => {
    expectTypeOf<DomainAnnotation>().toMatchTypeOf<SharedAnnotation>();
    expectTypeOf<SharedAnnotation>().toMatchTypeOf<DomainAnnotation>();
  });

  it('Comment', () => {
    expectTypeOf<DomainComment>().toMatchTypeOf<SharedComment>();
    expectTypeOf<SharedComment>().toMatchTypeOf<DomainComment>();
  });

  it('Team', () => {
    expectTypeOf<DomainTeam>().toMatchTypeOf<SharedTeam>();
    expectTypeOf<SharedTeam>().toMatchTypeOf<DomainTeam>();
  });

  it('TeamMember', () => {
    expectTypeOf<DomainTeamMember>().toMatchTypeOf<SharedTeamMember>();
    expectTypeOf<SharedTeamMember>().toMatchTypeOf<DomainTeamMember>();
  });

  it('Guideline', () => {
    expectTypeOf<DomainGuideline>().toMatchTypeOf<SharedGuideline>();
    expectTypeOf<SharedGuideline>().toMatchTypeOf<DomainGuideline>();
  });

  it('SharedLink', () => {
    expectTypeOf<DomainSharedLink>().toMatchTypeOf<SharedSharedLink>();
    expectTypeOf<SharedSharedLink>().toMatchTypeOf<DomainSharedLink>();
  });

  it('NotificationPayload', () => {
    expectTypeOf<DomainNotificationPayload>().toMatchTypeOf<SharedNotificationPayload>();
    expectTypeOf<SharedNotificationPayload>().toMatchTypeOf<DomainNotificationPayload>();
  });

  it('Notification', () => {
    expectTypeOf<DomainNotification>().toMatchTypeOf<SharedNotification>();
    expectTypeOf<SharedNotification>().toMatchTypeOf<DomainNotification>();
  });

  /**
   * Strict equality assertions on the enum-style string-literal unions
   * declared in both packages. `toEqualTypeOf` is exact (unlike
   * `toMatchTypeOf`), so any divergence — a missing or extra member on
   * either side — fails the build. The closed enums driving wire-shape
   * validation (Zod `.enum([...])`) MUST stay in lockstep with the
   * domain-side unions; this block is the failsafe.
   */
  it('enums', () => {
    expectTypeOf<DomainAnnotationType>().toEqualTypeOf<SharedAnnotationType>();
    expectTypeOf<DomainAnnotationStatus>().toEqualTypeOf<SharedAnnotationStatus>();
    expectTypeOf<DomainSeverity>().toEqualTypeOf<SharedSeverity>();
    expectTypeOf<DomainTeamRole>().toEqualTypeOf<SharedTeamRole>();
    expectTypeOf<DomainProjectStatus>().toEqualTypeOf<SharedProjectStatus>();
    expectTypeOf<DomainBrowserFamily>().toEqualTypeOf<SharedBrowserFamily>();
    expectTypeOf<DomainOsFamily>().toEqualTypeOf<SharedOsFamily>();
    expectTypeOf<DomainDeviceType>().toEqualTypeOf<SharedDeviceType>();
    expectTypeOf<DomainNotificationKind>().toEqualTypeOf<SharedNotificationKind>();
    expectTypeOf<DomainAuthTokenKind>().toEqualTypeOf<SharedAuthTokenKind>();
  });
});
