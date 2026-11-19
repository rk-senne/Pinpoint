// @pinpoint/shared — entry point
//
// Vite/Rollup statically analyses the named exports of this barrel when
// it bundles the dashboard and the extension. The shared package compiles
// to CommonJS (`tsc --build` with the root `module: Node16` setting), and
// Rollup's `commonjs` plugin cannot trace identifiers re-exported through
// the `__exportStar` helper that TypeScript emits for `export *` from a
// CommonJS source. Listing each name explicitly below makes `tsc` emit
// `Object.defineProperty(exports, "X", { get })` records that the
// bundler can resolve at build time, and lets the extension and the
// dashboard keep importing from `@pinpoint/shared` without reaching
// into deep paths.

// types.ts only contributes TypeScript type declarations at runtime, so
// `export type *` is enough to keep them visible without dragging an
// `__exportStar` runtime call into the CJS bundle.
export type * from './types.js';

// Only schemas that have an actual runtime caller (`.parse(...)` or
// `.safeParse(...)`) are re-exported through the barrel. The schemas
// without an external caller stay defined inside `schemas.ts` so the
// `Annotation/Project/User/Team/Comment` schemas (the obvious public-API
// names) can re-use them, but they don't appear here. If a new caller
// needs one, add it back to this list.
export {
  // Enum schemas that adapter code parses directly.
  AnnotationTypeSchema,
  SeveritySchema,
  AnnotationStatusSchema,
  TeamRoleSchema,
  // Capture buffers used by the annotation HTTP route.
  CapturedConsoleEntrySchema,
  CapturedNetworkEntrySchema,
  // Diagnostics capture (Mission C2) + session replay (Mission C3) schemas
  // and bounds, validated at the HTTP boundary and reused by the clients.
  ConsoleLogEntrySchema,
  JsErrorEntrySchema,
  ConsoleLogsSchema,
  JsErrorsSchema,
  ReplayEventSchema,
  SessionReplaySchema,
  DIAGNOSTICS_MAX_ENTRIES,
  DIAGNOSTICS_MESSAGE_MAX,
  DIAGNOSTICS_STACK_MAX,
  DIAGNOSTICS_MAX_SERIALIZED_BYTES,
  REPLAY_EVENTS_MAX,
  // DOM/Environment payloads parsed at the HTTP boundary.
  DOMTargetSchema,
  EnvironmentMetadataSchema,
  // Aggregate-level public-API schemas (kept even if no current caller
  // uses `.parse()` on them — these are the obvious entry points).
  AnnotationSchema,
  CommentSchema,
  ProjectSchema,
  TeamSchema,
  UserSchema,
  // Screenshot markup payload validated server-side before render.
  MarkupDocumentSchema,
} from './schemas.js';

export {
  serializeAnnotation,
  deserializeAnnotation,
} from './serialization.js';

export { renderMarkupSvg, shapeToSvgString } from './markupRender.js';

export {
  parseUserAgent,
  detectBraveAndArcOverrides,
} from './userAgent.js';

export { signal, type Signal } from './signal.js';

export {
  SEVERITY_COLORS,
  SEVERITY_SHAPES,
  STATUS_LABELS,
  BRAND_COLORS,
  STATUS_PILL_COLORS,
  sharedStyleSheet,
  themeCss,
} from './theme.js';

export {
  PASSWORD_MIN_LENGTH,
  validatePassword,
  getCommonPasswordCount,
  type PasswordValidation,
} from './passwordPolicy.js';

export {
  PaginationParamsSchema,
  type PaginationParams,
  type PaginatedResponse,
  paginationMeta,
} from './pagination.js';

export {
  setText,
  el,
  escapeHtml,
  isSafeUrl,
  type Child,
  type Attrs,
} from './safeText.js';
