// @pinpoint/shared — TypeScript type definitions

// --- Enums as union types ---

export type AnnotationType = 'note' | 'suggestion' | 'guideline';
export type Severity = 'critical' | 'major' | 'minor' | 'informational';
export type AnnotationStatus = 'active' | 'in_progress' | 'resolved';
export type TeamRole = 'owner' | 'admin' | 'viewer';
export type ProjectStatus = 'active' | 'archived';

// Closed enums for Environment_Metadata (Req 17). Canonical source of truth.
export type BrowserFamily =
  | 'Chrome'
  | 'Edge'
  | 'Safari'
  | 'Firefox'
  | 'Opera'
  | 'Brave'
  | 'Arc'
  | 'Other'
  | 'unknown';

export type OsFamily =
  | 'macOS'
  | 'Windows'
  | 'Linux'
  | 'iOS'
  | 'Android'
  | 'ChromeOS'
  | 'Other'
  | 'unknown';

export type DeviceType = 'desktop' | 'tablet' | 'mobile';

// Notification queue (Req 28)
export type NotificationStatus = 'pending' | 'sent' | 'failed';

// Auth tokens (replaces password_resets per Req 4 / 20)
export type AuthTokenKind = 'verify_email' | 'reset_password' | 'team_invite';

// Capture_Buffer (Req 36) — rolling console + network entries attached to
// bug-report annotations. Both buffers are bounded to 50 entries by the
// extension's CaptureBuffer module; the schema permits any non-negative count
// because the server may receive payloads from older extensions.
export type CapturedConsoleLevel = 'log' | 'warn' | 'error';

export interface CapturedConsoleEntry {
  level: CapturedConsoleLevel;
  message: string;       // formatted message
  timestamp: string;     // ISO 8601
  stack?: string;        // present for warn/error when available
}

export interface CapturedNetworkEntry {
  name: string;             // request URL
  initiatorType: string;    // 'xmlhttprequest' | 'fetch' | 'script' | ...
  startTime: number;        // PerformanceObserver high-res ms
  duration: number;
  transferSize?: number;
  responseStatus?: number;  // when supported
}

// --- Domain interfaces ---

export interface DOMTarget {
  cssSelector: string;
  xpath: string;
  pageX: number;
  pageY: number;
  tagName: string;
  textSnippet: string; // first 100 chars of element text
}

/**
 * Browser, OS, and device metadata captured per Annotation (Req 17).
 *
 * The required fields (`browserFamily`, `browserVersion`, `osFamily`,
 * `osVersion`, `deviceType`, `userAgentRaw`) are produced by `parseUserAgent`
 * and are present on every Annotation. The optional viewport / pixel-ratio
 * fields are kept for back-compat with the legacy bug-report payload that
 * Phase 0 stored under `browserMeta`.
 */
export interface EnvironmentMetadata {
  browserFamily: BrowserFamily;
  browserVersion: string | null;
  osFamily: OsFamily;
  osVersion: string | null;
  deviceType: DeviceType;
  userAgentRaw: string;
  // Legacy bug-report fields kept for back-compat
  viewportWidth?: number;
  viewportHeight?: number;
  devicePixelRatio?: number;
}

export interface Page {
  id: string;
  projectId: string;
  url: string;
  title: string | null;
  createdAt: string; // ISO 8601
}

export interface Annotation {
  id: string;
  projectId: string;
  pageId: string;       // FK to pages (Req 23). Replaces legacy pageUrl.
  pageUrl?: string;     // Derived field populated by API responses for client convenience.
  type: AnnotationType;
  severity: Severity;
  status: AnnotationStatus;
  body: string;
  authorId: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  target: DOMTarget;
  environment: EnvironmentMetadata; // REQUIRED on every Annotation (Req 17.3).
  guidelineId?: string;
  assigneeId?: string;
  dueDate?: string; // ISO 8601
  pinNumber: number;
  /**
   * S3-compatible object storage key for the screenshot PNG attached to
   * this annotation (Req 34.3). Optional because the per-annotation
   * capture toggle (Req 34.2) may have been disabled, or the annotation
   * predates the screenshot pipeline.
   */
  screenshotObjectKey?: string;
  /**
   * Rolling console buffer captured by the extension at bug-report submission
   * (Req 36.2). Populated only when the annotation is a note with severity in
   * {critical, major}; otherwise null/undefined. Bounded to 50 entries.
   */
  capturedConsole?: CapturedConsoleEntry[] | null;
  /**
   * Rolling network buffer captured by the extension at bug-report submission
   * (Req 36.2). Populated only when the annotation is a note with severity in
   * {critical, major}; otherwise null/undefined. Bounded to 50 entries.
   */
  capturedNetwork?: CapturedNetworkEntry[] | null;
  /**
   * Client-supplied UUID for offline-replay idempotency (Req 44.3). When the
   * Extension's Syncer replays a queued create-Annotation, it attaches the
   * locally generated UUID; the server returns the existing row instead of
   * inserting a duplicate.
   */
  clientRequestId?: string;
  /**
   * Client-only flag (Req 44.6, task 36.7). Set to `true` by the
   * Extension's Syncer when, on replay of a queued create-Annotation,
   * the stored DOM target's selector either no longer resolves on the
   * live page or resolves to an element whose tag/bounding box differs
   * from the snapshot captured at click time. The Extension overlay
   * uses the flag to render the warning ring on the pin
   * (`<fl-annotation-pin data-fallback="true">`) and to surface a
   * "Target may have moved" notice in the popover. Never persisted to
   * the server — the Extension strips it before send and re-derives it
   * locally on each replay.
   */
  targetStale?: boolean;
  /**
   * Session replay events captured by the extension recorder (last N
   * seconds before annotation creation). Used for playback in the
   * dashboard's ReplayPlayer component.
   */
  sessionReplay?: ReplayEvent[] | null;
}

export interface Comment {
  id: string;
  annotationId: string;
  authorId: string;
  body: string;
  mentions: string[]; // user IDs
  createdAt: string; // ISO 8601
  /** Client-supplied UUID for offline-replay idempotency (Req 44.3). */
  clientRequestId?: string;
}

export interface Project {
  id: string;
  name: string;
  urls: string[];
  status: ProjectStatus;
  ownerId: string;
  teamId?: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

export interface Team {
  id: string;
  name: string;
  ownerId: string;
  createdAt: string; // ISO 8601
}

export interface TeamMember {
  userId: string;
  teamId: string;
  role: TeamRole;
  joinedAt: string; // ISO 8601
}

export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string;
  notificationPreferences: NotificationPreferences;
  createdAt: string; // ISO 8601
}

export interface NotificationPreferences {
  newAnnotation: boolean;
  newComment: boolean;
  promotedToOwner: boolean;
  projectDeleted: boolean;
}

export interface Guideline {
  id: string;
  name: string;
  description: string;
  isDefault: boolean; // true for Nielsen's 10
  createdByUserId?: string;
}

export interface SharedLink {
  id: string;
  projectId: string;
  /** bcrypt hash; `null` = no password (open link); `undefined` = unset. */
  passwordHash?: string | null;
  createdAt: string; // ISO 8601
  /** ISO 8601; set after 3 failed attempts. `null` clears the lock. */
  lockedUntil?: string | null;
  failedAttempts: number;
}

/** Discriminated payload for a queued Notification (Req 28). */
export type NotificationPayload = {
  kind:
    | 'annotation_created'
    | 'comment_created'
    | 'comment_on_own'
    | 'mention'
    | 'status_change'
    | 'daily_digest'
    | 'promoted_to_owner'
    | 'project_deleted'
    | 'verify_email';
  recipientUserId: string;
  [key: string]: unknown;
};

/** Durable notification queue row (Req 28). */
export interface Notification {
  id: string;
  status: NotificationStatus;
  attempts: number;
  payload: NotificationPayload;
  scheduledAt: string; // ISO 8601
  lastError?: string;
  createdAt: string;   // ISO 8601
  updatedAt: string;   // ISO 8601
}

/** One-shot auth tokens (email verification, password reset, team invite). */
export interface AuthToken {
  id: string;
  userId: string;
  kind: AuthTokenKind;
  tokenHash: string;
  expiresAt: string; // ISO 8601
  used: boolean;
  createdAt: string; // ISO 8601
}

// --- Markup_Document (Req 35) — vector overlay JSON for screenshots ---

/**
 * Hex color string used by markup shapes (e.g. `#ef4444`). Unconstrained at
 * the type level so callers can pass any valid CSS color; the server-side
 * Zod schema validates the rough shape but accepts any string.
 */
export type MarkupColor = string;

/**
 * Vector primitives that appear in `MarkupDocument.shapes`. Matching the
 * design example (§Markup Document Format) and the canonical structure
 * already implemented by the `<fl-markup-editor>` Custom Element. Shapes
 * paint in array order (later shapes draw on top of earlier ones).
 *
 * Pixelate rectangles are intentionally NOT given a `color` — they are
 * rasterized against the source bitmap on the server (sharp.blur over the
 * region) or the client (box-average raster in `<fl-markup-editor>`),
 * producing a region-specific pixelation that varies with the image.
 */
export type MarkupShape =
  | {
      type: 'rect';
      x: number;
      y: number;
      width: number;
      height: number;
      color: MarkupColor;
      strokeWidth: number;
    }
  | {
      type: 'arrow';
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      color: MarkupColor;
      strokeWidth: number;
    }
  | {
      type: 'stroke';
      points: Array<{ x: number; y: number }>;
      color: MarkupColor;
      strokeWidth: number;
    }
  | {
      type: 'pixelate';
      x: number;
      y: number;
      width: number;
      height: number;
      pixelSize: number;
    };

/**
 * Persisted markup document (Req 35.2). Stored alongside the screenshot
 * PNG as a sibling S3 object at `<screenshot_object_key>.markup.json`;
 * viewers fetch both and composite the SVG overlay over the bitmap
 * client-side. Versioned so a future schema change can bump and continue
 * to read older payloads.
 */
export interface MarkupDocument {
  version: 1;
  shapes: MarkupShape[];
}

// --- API Error Envelope ---

export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: object;
  };
}

// --- Session Replay ---

export interface ReplayEvent {
  type: 'mousemove' | 'click' | 'scroll' | 'input' | 'mutation' | 'resize';
  timestamp: number;
  data: unknown;
}
