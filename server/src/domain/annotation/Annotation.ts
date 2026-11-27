// Annotation entity (Phase 1.5 / task 4.6.1).
//
// The richer domain shape: validates required fields and captures
// invariants the wire-level Zod schema enforces only loosely. Plain TS
// interface today; subsequent waves can promote this to a class with
// constructor validation if domain logic warrants it.

import type { DOMTarget } from './DOMTarget.js';
import type { EnvironmentMetadata } from './EnvironmentMetadata.js';

export type AnnotationType = 'note' | 'suggestion' | 'guideline';
export type Severity = 'critical' | 'major' | 'minor' | 'informational';
export type AnnotationStatus = 'active' | 'in_progress' | 'resolved';

// Capture_Buffer (Req 36) — rolling console + network entries attached to
// bug-report annotations. The extension caps both arrays at 50 entries.
export type CapturedConsoleLevel = 'log' | 'warn' | 'error';

export interface CapturedConsoleEntry {
  level: CapturedConsoleLevel;
  message: string;
  timestamp: string; // ISO 8601
  stack?: string;
}

export interface CapturedNetworkEntry {
  name: string;
  initiatorType: string;
  startTime: number;
  duration: number;
  transferSize?: number;
  responseStatus?: number;
}

// Diagnostics capture (Mission C2) — bounded, PII-scrubbed console + uncaught
// error snapshots attached to an annotation. Mirrors `@pinpoint/shared`.
export type ConsoleLogLevel = 'log' | 'warn' | 'error';

export interface ConsoleLogEntry {
  level: ConsoleLogLevel;
  message: string;
  timestamp: string; // ISO 8601
  stack?: string;
}

export type JsErrorKind = 'error' | 'unhandledrejection';

export interface JsErrorEntry {
  kind: JsErrorKind;
  message: string;
  timestamp: string; // ISO 8601
  stack?: string;
  source?: string;
  lineno?: number;
  colno?: number;
}

// Session replay (Mission C3) — redaction-applied event list recorded by the
// extension and replayed in the dashboard.
export interface ReplayEvent {
  type: 'mousemove' | 'click' | 'scroll' | 'input' | 'mutation' | 'resize';
  timestamp: number;
  /** Optional in the wire schema (ReplayEventSchema); some events carry no payload. */
  data?: unknown;
}

export interface Annotation {
  id: string;
  /** Owning organisation; used by use cases to scope lookups to the caller's tenant. */
  orgId?: string;
  projectId: string;
  pageId: string;       // FK to Page (Req 23). Replaces legacy pageUrl.
  pageUrl?: string;     // Derived for client convenience; not stored on the entity.
  type: AnnotationType;
  severity: Severity;
  status: AnnotationStatus;
  body: string;
  /** NULL for guest/widget submissions (see `isGuest`). */
  authorId: string | null;
  createdAt: string;
  updatedAt: string;
  target: DOMTarget;
  environment: EnvironmentMetadata; // REQUIRED (Req 17.3)
  guidelineId?: string;
  assigneeId?: string;
  dueDate?: string;
  pinNumber: number;
  screenshotObjectKey?: string;
  capturedConsole?: CapturedConsoleEntry[] | null;
  capturedNetwork?: CapturedNetworkEntry[] | null;
  /** Diagnostics capture (Mission C2) — bounded, scrubbed console snapshot. */
  consoleLogs?: ConsoleLogEntry[] | null;
  /** Diagnostics capture (Mission C2) — bounded, scrubbed uncaught errors. */
  jsErrors?: JsErrorEntry[] | null;
  /** Session replay (Mission C3) — redaction-applied event list. */
  sessionReplay?: ReplayEvent[] | null;
  /** Client-supplied UUID for offline-replay idempotency (Req 44.3). */
  clientRequestId?: string;
  /** Whether this annotation was submitted by a guest (no account). */
  isGuest?: boolean;
  /** Display name of the guest submitter. */
  guestName?: string | null;
  /** Optional email of the guest submitter. */
  guestEmail?: string | null;
}

/** Patch shape passed to `AnnotationRepo.update`. */
export interface AnnotationPatch {
  body?: string;
  severity?: Severity;
  assigneeId?: string | null;
  dueDate?: string | null;
  status?: AnnotationStatus;
}

/** Input shape for creating a new Annotation; the repo assigns id + timestamps. */
export interface NewAnnotation {
  projectId: string;
  pageId: string;
  type: AnnotationType;
  severity: Severity;
  status: AnnotationStatus;
  body: string;
  /** NULL for guest/widget submissions (see `isGuest`). */
  authorId: string | null;
  target: DOMTarget;
  environment: EnvironmentMetadata;
  pinNumber: number;
  orgId?: string;
  guidelineId?: string;
  assigneeId?: string;
  dueDate?: string;
  capturedConsole?: CapturedConsoleEntry[] | null;
  capturedNetwork?: CapturedNetworkEntry[] | null;
  consoleLogs?: ConsoleLogEntry[] | null;
  jsErrors?: JsErrorEntry[] | null;
  sessionReplay?: ReplayEvent[] | null;
  clientRequestId?: string;
  /** Whether this annotation was submitted by a guest (no account). */
  isGuest?: boolean;
  /** Display name of the guest submitter. */
  guestName?: string | null;
  /** Optional email of the guest submitter. */
  guestEmail?: string | null;
}
