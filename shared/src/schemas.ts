// @pinpoint/shared — Zod validation schemas
import { z } from 'zod';

// --- ISO 8601 date string validator ---

const iso8601 = z.string().refine(
  (val) => !isNaN(Date.parse(val)),
  { message: 'Invalid ISO 8601 date string' },
);

// --- Enum schemas ---

export const AnnotationTypeSchema = z.enum(['note', 'suggestion', 'guideline']);
export const SeveritySchema = z.enum(['critical', 'major', 'minor', 'informational']);
export const AnnotationStatusSchema = z.enum(['active', 'in_progress', 'resolved']);
export const TeamRoleSchema = z.enum(['owner', 'admin', 'viewer']);
export const ProjectStatusSchema = z.enum(['active', 'archived']);

export const BrowserFamilySchema = z.enum([
  'Chrome',
  'Edge',
  'Safari',
  'Firefox',
  'Opera',
  'Brave',
  'Arc',
  'Other',
  'unknown',
]);

export const OsFamilySchema = z.enum([
  'macOS',
  'Windows',
  'Linux',
  'iOS',
  'Android',
  'ChromeOS',
  'Other',
  'unknown',
]);

export const DeviceTypeSchema = z.enum(['desktop', 'tablet', 'mobile']);

export const NotificationStatusSchema = z.enum(['pending', 'sent', 'failed']);

export const AuthTokenKindSchema = z.enum([
  'verify_email',
  'reset_password',
  'team_invite',
]);

// Capture_Buffer (Req 36) — rolling console + network entries attached to a
// bug-report annotation by the extension.
export const CapturedConsoleLevelSchema = z.enum(['log', 'warn', 'error']);

export const CapturedConsoleEntrySchema = z.object({
  level: CapturedConsoleLevelSchema,
  message: z.string(),
  timestamp: iso8601,
  stack: z.string().optional(),
});

export const CapturedNetworkEntrySchema = z.object({
  name: z.string(),
  initiatorType: z.string(),
  startTime: z.number().nonnegative(),
  duration: z.number().nonnegative(),
  transferSize: z.number().nonnegative().optional(),
  responseStatus: z.number().int().optional(),
});

// --- Domain schemas ---

export const DOMTargetSchema = z.object({
  cssSelector: z.string(),
  xpath: z.string(),
  pageX: z.number(),
  pageY: z.number(),
  tagName: z.string(),
  textSnippet: z.string(),
});

/**
 * Environment_Metadata schema (Req 17). Required fields are produced by
 * `parseUserAgent`; the viewport / pixel-ratio fields are optional carry-overs
 * from the legacy bug-report `browserMeta` payload.
 */
export const EnvironmentMetadataSchema = z.object({
  browserFamily: BrowserFamilySchema,
  browserVersion: z.string().nullable(),
  osFamily: OsFamilySchema,
  osVersion: z.string().nullable(),
  deviceType: DeviceTypeSchema,
  userAgentRaw: z.string(),
  viewportWidth: z.number().optional(),
  viewportHeight: z.number().optional(),
  devicePixelRatio: z.number().optional(),
});

export const PageSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  url: z.string(),
  title: z.string().nullable(),
  createdAt: iso8601,
});

export const AnnotationSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  pageId: z.string(),
  // Derived field populated by API responses; tolerated by the schema but not required.
  pageUrl: z.string().optional(),
  type: AnnotationTypeSchema,
  severity: SeveritySchema,
  status: AnnotationStatusSchema,
  body: z.string(),
  authorId: z.string(),
  createdAt: iso8601,
  updatedAt: iso8601,
  target: DOMTargetSchema,
  environment: EnvironmentMetadataSchema, // Required (Req 17.3)
  guidelineId: z.string().optional(),
  assigneeId: z.string().optional(),
  dueDate: iso8601.optional(),
  pinNumber: z.number().int(),
  // S3 object key for an attached screenshot (Req 34.3). Optional: capture
  // is per-annotation and may be disabled by the reporter (Req 34.2).
  screenshotObjectKey: z.string().optional(),
  // Capture_Buffer (Req 36.2) — populated only on bug-report submissions
  // (type=note, severity ∈ {critical, major}). Both buffers are bounded to 50
  // entries by the extension's CaptureBuffer module; the schema accepts any
  // length so older clients can post smaller payloads. Nullable so a JSON
  // payload can carry an explicit `null` round-tripped from the JSONB column.
  capturedConsole: z.array(CapturedConsoleEntrySchema).nullable().optional(),
  capturedNetwork: z.array(CapturedNetworkEntrySchema).nullable().optional(),
  // Client-supplied UUID for offline-replay idempotency (Req 44.3).
  clientRequestId: z.string().uuid().optional(),
  // Client-only flag (Req 44.6) — re-derived locally on each replay; the
  // Extension strips it before send so it should never appear on a server
  // round-trip. Listed here so `safeParse(...)` round-trips don't silently
  // drop the flag when the schema is used to validate in-memory state on
  // the client. Mirrors the comment on `Annotation.targetStale` in `types.ts`.
  targetStale: z.boolean().optional(),
});

export const CommentSchema = z.object({
  id: z.string(),
  annotationId: z.string(),
  authorId: z.string(),
  body: z.string(),
  mentions: z.array(z.string()),
  createdAt: iso8601,
  // Client-supplied UUID for offline-replay idempotency (Req 44.3).
  clientRequestId: z.string().uuid().optional(),
});

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  urls: z.array(z.string()),
  status: ProjectStatusSchema,
  ownerId: z.string(),
  teamId: z.string().optional(),
  createdAt: iso8601,
  updatedAt: iso8601,
});

export const TeamSchema = z.object({
  id: z.string(),
  name: z.string(),
  ownerId: z.string(),
  createdAt: iso8601,
});

export const TeamMemberSchema = z.object({
  userId: z.string(),
  teamId: z.string(),
  role: TeamRoleSchema,
  joinedAt: iso8601,
});

export const NotificationPreferencesSchema = z.object({
  newAnnotation: z.boolean(),
  newComment: z.boolean(),
  promotedToOwner: z.boolean(),
  projectDeleted: z.boolean(),
});

export const UserSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string(),
  avatarUrl: z.string().optional(),
  notificationPreferences: NotificationPreferencesSchema,
  createdAt: iso8601,
});

export const GuidelineSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  isDefault: z.boolean(),
  createdByUserId: z.string().optional(),
});

export const SharedLinkSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  passwordHash: z.string().nullable().optional(),
  createdAt: iso8601,
  lockedUntil: iso8601.nullable().optional(),
  failedAttempts: z.number().int(),
});

/**
 * Notification payload (Req 28). The `kind` discriminator is closed; additional
 * payload-specific fields are tolerated via `passthrough`.
 */
export const NotificationPayloadSchema = z
  .object({
    kind: z.enum([
      'annotation_created',
      'comment_created',
      'mention',
      'promoted_to_owner',
      'project_deleted',
      'verify_email',
    ]),
    recipientUserId: z.string(),
  })
  .passthrough();

export const NotificationSchema = z.object({
  id: z.string(),
  status: NotificationStatusSchema,
  attempts: z.number().int().nonnegative(),
  payload: NotificationPayloadSchema,
  scheduledAt: iso8601,
  lastError: z.string().optional(),
  createdAt: iso8601,
  updatedAt: iso8601,
});

export const AuthTokenSchema = z.object({
  id: z.string(),
  userId: z.string(),
  kind: AuthTokenKindSchema,
  tokenHash: z.string(),
  expiresAt: iso8601,
  used: z.boolean(),
  createdAt: iso8601,
});

export const ApiErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.object({}).passthrough().optional(),
  }),
});

// --- Markup_Document (Req 35) — vector overlay for screenshots ---

const MarkupColorSchema = z.string();

const MarkupRectShapeSchema = z.object({
  type: z.literal('rect'),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  color: MarkupColorSchema,
  strokeWidth: z.number().positive(),
});

const MarkupArrowShapeSchema = z.object({
  type: z.literal('arrow'),
  x1: z.number(),
  y1: z.number(),
  x2: z.number(),
  y2: z.number(),
  color: MarkupColorSchema,
  strokeWidth: z.number().positive(),
});

const MarkupStrokeShapeSchema = z.object({
  type: z.literal('stroke'),
  points: z.array(z.object({ x: z.number(), y: z.number() })),
  color: MarkupColorSchema,
  strokeWidth: z.number().positive(),
});

const MarkupPixelateShapeSchema = z.object({
  type: z.literal('pixelate'),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  pixelSize: z.number().positive(),
});

export const MarkupShapeSchema = z.discriminatedUnion('type', [
  MarkupRectShapeSchema,
  MarkupArrowShapeSchema,
  MarkupStrokeShapeSchema,
  MarkupPixelateShapeSchema,
]);

/**
 * Markup_Document (Req 35.2). Persisted as a sibling S3 object next to a
 * screenshot at `<screenshot_object_key>.markup.json`; the server only
 * validates the shape, never modifies it.
 */
export const MarkupDocumentSchema = z.object({
  version: z.literal(1),
  shapes: z.array(MarkupShapeSchema),
});
