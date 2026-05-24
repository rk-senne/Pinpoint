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

export interface Annotation {
  id: string;
  projectId: string;
  pageId: string;       // FK to Page (Req 23). Replaces legacy pageUrl.
  pageUrl?: string;     // Derived for client convenience; not stored on the entity.
  type: AnnotationType;
  severity: Severity;
  status: AnnotationStatus;
  body: string;
  authorId: string;
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
  /** Client-supplied UUID for offline-replay idempotency (Req 44.3). */
  clientRequestId?: string;
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
  authorId: string;
  target: DOMTarget;
  environment: EnvironmentMetadata;
  pinNumber: number;
  guidelineId?: string;
  assigneeId?: string;
  dueDate?: string;
  capturedConsole?: CapturedConsoleEntry[] | null;
  capturedNetwork?: CapturedNetworkEntry[] | null;
  clientRequestId?: string;
}
