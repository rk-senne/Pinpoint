import { z } from 'zod';
import type { Request, Response } from 'express';

/**
 * API Documentation generator — produces OpenAPI 3.0 JSON from registered
 * Zod schemas. Routes register their schemas via `doc()`, and the
 * `/api/v1/docs.json` endpoint serves the compiled spec.
 *
 * Usage in route files:
 *   doc('POST', '/api/v1/feedback', { body: FeedbackCreateSchema, description: '...' })
 *
 * Then mount: app.get('/api/v1/docs.json', serveApiDocs)
 */

interface EndpointDoc {
  method: string;
  path: string;
  summary?: string;
  description?: string;
  body?: z.ZodType;
  query?: z.ZodType;
  response?: z.ZodType;
  tags?: string[];
  auth?: 'bearer' | 'cookie' | 'api-key' | 'none';
  errors?: Array<{ status: number; code: string; description: string }>;
}

const registry: EndpointDoc[] = [];

export function doc(method: string, path: string, opts: Omit<EndpointDoc, 'method' | 'path'>): void {
  registry.push({ method: method.toUpperCase(), path, ...opts });
}

function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, val] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(val as z.ZodType);
      if (!(val instanceof z.ZodOptional)) required.push(key);
    }
    return { type: 'object', properties, ...(required.length ? { required } : {}) };
  }
  if (schema instanceof z.ZodString) return { type: 'string' };
  if (schema instanceof z.ZodNumber) return { type: 'number' };
  if (schema instanceof z.ZodBoolean) return { type: 'boolean' };
  if (schema instanceof z.ZodArray) {
    return { type: 'array', items: zodToJsonSchema((schema as any)._def.type) };
  }
  if (schema instanceof z.ZodOptional) {
    return zodToJsonSchema((schema as any)._def.innerType);
  }
  if (schema instanceof z.ZodEnum) {
    return { type: 'string', enum: (schema as any)._def.values };
  }
  return { type: 'string' };
}

function buildSpec(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const endpoint of registry) {
    if (!paths[endpoint.path]) paths[endpoint.path] = {};
    const method = endpoint.method.toLowerCase();

    const operation: Record<string, unknown> = {
      summary: endpoint.summary ?? endpoint.description ?? `${endpoint.method} ${endpoint.path}`,
      description: endpoint.description ?? '',
      tags: endpoint.tags ?? [endpoint.path.split('/')[3] ?? 'general'],
      responses: {
        '200': { description: 'Success' },
      },
    };

    if (endpoint.auth && endpoint.auth !== 'none') {
      if (endpoint.auth === 'cookie') {
        operation.security = [{ Cookie: [] }];
      } else {
        operation.security = [{ [endpoint.auth === 'api-key' ? 'ApiKey' : 'Bearer']: [] }];
      }
    }

    if (endpoint.body) {
      operation.requestBody = {
        required: true,
        content: { 'application/json': { schema: zodToJsonSchema(endpoint.body) } },
      };
    }

    if (endpoint.query) {
      const schema = zodToJsonSchema(endpoint.query);
      if ((schema as any).properties) {
        operation.parameters = Object.entries((schema as any).properties).map(
          ([name, s]) => ({ name, in: 'query', schema: s }),
        );
      }
    }

    if (endpoint.response) {
      operation.responses = {
        '200': {
          description: 'Success',
          content: { 'application/json': { schema: zodToJsonSchema(endpoint.response) } },
        },
      };
    }

    // Merge error responses
    if (endpoint.errors) {
      const responses = (operation.responses ?? {}) as Record<string, unknown>;
      for (const err of endpoint.errors) {
        responses[String(err.status)] = {
          description: err.description,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  error: {
                    type: 'object',
                    properties: {
                      code: { type: 'string', example: err.code },
                      message: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        };
      }
      operation.responses = responses;
    }

    paths[endpoint.path][method] = operation;
  }

  return {
    openapi: '3.0.3',
    info: {
      title: 'Pinpoint API',
      version: '1.0.0',
      description: 'Pinpoint — visual feedback and annotation platform. Complete REST API documentation.',
    },
    servers: [{ url: '/api/v1', description: 'Primary API server' }],
    'x-rateLimit': {
      description: 'Rate limiting is applied at two levels: per-tenant and per-IP for auth endpoints.',
      tenantLimit: {
        description: 'Authenticated requests are rate-limited per organization using a token-bucket algorithm.',
        maxRequests: 1000,
        window: '1 hour',
        refillRate: '1000 tokens per hour',
        headers: {
          'X-RateLimit-Remaining': 'Tokens remaining in the current window',
          'Retry-After': 'Seconds until the next token is available (only on 429)',
        },
        errorResponse: {
          status: 429,
          body: { error: { code: 'TENANT_RATE_LIMIT', message: 'Rate limit exceeded for your organization. Please retry later.' } },
        },
      },
      authLimit: {
        description: 'Authentication endpoints have a strict per-IP+email rate limit to prevent brute-force attacks.',
        maxRequests: 5,
        window: '1 minute',
        keyShape: '(IP /64 subnet, email)',
        appliesTo: ['/auth/login', '/auth/register', '/auth/reset-password', '/auth/resend-verification', '/shared/:linkId/verify'],
        headers: {
          'RateLimit-Policy': 'Standard rate limit headers (RFC draft)',
          'Retry-After': 'Seconds until the limit resets',
        },
        errorResponse: {
          status: 429,
          body: { error: { code: 'AUTH_RATE_LIMIT', message: 'Too many authentication attempts. Please wait and try again.' } },
        },
      },
    },
    components: {
      securitySchemes: {
        Bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'JWT access token returned by POST /auth/login' },
        Cookie: { type: 'apiKey', in: 'cookie', name: 'fl_session', description: 'HTTP-only session cookie set on login' },
        ApiKey: { type: 'apiKey', in: 'header', name: 'Authorization', description: 'API key prefixed with Bearer pk_...' },
      },
    },
    paths,
  };
}

export function serveApiDocs(_req: Request, res: Response): void {
  res.json(buildSpec());
}

// =============================================================================
// ENDPOINT REGISTRATIONS
// =============================================================================

// -----------------------------------------------------------------------------
// AUTH ENDPOINTS
// -----------------------------------------------------------------------------

const RegisterBodySchema = z.object({
  email: z.string(),
  password: z.string(),
  name: z.string(),
});

const RegisterResponseSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    verified: z.boolean(),
  }),
});

doc('POST', '/api/v1/auth/register', {
  summary: 'Register a new user account',
  description: 'Creates a new user account and sends an email verification link. Returns the created user object.',
  tags: ['auth'],
  auth: 'none',
  body: RegisterBodySchema,
  response: RegisterResponseSchema,
  errors: [
    { status: 400, code: 'VALIDATION_ERROR', description: 'Invalid registration payload (missing or malformed fields)' },
    { status: 409, code: 'EMAIL_ALREADY_EXISTS', description: 'An account with this email already exists' },
  ],
});

const LoginBodySchema = z.object({
  email: z.string(),
  password: z.string(),
});

const LoginResponseSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
  }),
  token: z.string(),
  csrfToken: z.string(),
});

doc('POST', '/api/v1/auth/login', {
  summary: 'Authenticate user credentials',
  description: 'Validates email and password, returns a JWT token and sets session cookies (fl_session, fl_csrf). The token can be used as a Bearer header or the session cookie for subsequent requests.',
  tags: ['auth'],
  auth: 'none',
  body: LoginBodySchema,
  response: LoginResponseSchema,
  errors: [
    { status: 400, code: 'VALIDATION_ERROR', description: 'Invalid login payload' },
    { status: 401, code: 'INVALID_CREDENTIALS', description: 'Email or password is incorrect' },
    { status: 403, code: 'EMAIL_NOT_VERIFIED', description: 'User must verify their email before logging in' },
    { status: 429, code: 'AUTH_RATE_LIMIT', description: 'Too many login attempts' },
  ],
});

doc('POST', '/api/v1/auth/logout', {
  summary: 'End the current session',
  description: 'Invalidates the current session token and clears session cookies. Accepts either Bearer token or cookie authentication.',
  tags: ['auth'],
  auth: 'cookie',
  response: z.object({ success: z.boolean() }),
  errors: [
    { status: 401, code: 'UNAUTHORIZED', description: 'No valid session to terminate' },
  ],
});

doc('POST', '/api/v1/auth/refresh', {
  summary: 'Refresh an expiring token',
  description: 'Exchanges a valid (but possibly near-expiry) JWT for a fresh token. Accepts the token via Authorization header or fl_session cookie. When cookie-based, both cookies are re-issued.',
  tags: ['auth'],
  auth: 'bearer',
  response: z.object({ token: z.string(), csrfToken: z.string().optional() }),
  errors: [
    { status: 401, code: 'TOKEN_EXPIRED', description: 'The provided token is no longer valid for refresh' },
    { status: 401, code: 'TOKEN_REVOKED', description: 'The token has been revoked (e.g. after password change)' },
  ],
});

doc('POST', '/api/v1/auth/verify-email', {
  summary: 'Verify user email address',
  description: 'Confirms the user\'s email using the token sent during registration. The token is passed as a URL parameter: POST /auth/verify-email/:token.',
  tags: ['auth'],
  auth: 'none',
  body: z.object({ token: z.string() }),
  response: z.object({ verified: z.boolean() }),
  errors: [
    { status: 400, code: 'INVALID_TOKEN', description: 'The verification token is invalid or expired' },
  ],
});

doc('POST', '/api/v1/auth/reset-password', {
  summary: 'Request a password reset email',
  description: 'Sends a password reset link to the provided email if an account exists. Always returns a success message regardless of whether the email is registered (prevents enumeration).',
  tags: ['auth'],
  auth: 'none',
  body: z.object({ email: z.string() }),
  response: z.object({ message: z.string() }),
  errors: [
    { status: 400, code: 'VALIDATION_ERROR', description: 'Invalid email format' },
    { status: 429, code: 'AUTH_RATE_LIMIT', description: 'Too many reset attempts' },
  ],
});

doc('POST', '/api/v1/auth/reset-password/complete', {
  summary: 'Complete password reset with token',
  description: 'Sets a new password using the reset token from the email link. The token is passed as a URL parameter: POST /auth/reset-password/:token. The request body contains the new password.',
  tags: ['auth'],
  auth: 'none',
  body: z.object({ password: z.string() }),
  response: z.object({ message: z.string() }),
  errors: [
    { status: 400, code: 'INVALID_TOKEN', description: 'The reset token is invalid or expired' },
    { status: 400, code: 'WEAK_PASSWORD', description: 'The new password does not meet strength requirements' },
  ],
});

// -----------------------------------------------------------------------------
// PROJECTS ENDPOINTS
// -----------------------------------------------------------------------------

const ProjectQuerySchema = z.object({
  page: z.number().optional(),
  limit: z.number().optional(),
  search: z.string().optional(),
  status: z.enum(['active', 'archived']).optional(),
});

const ProjectResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  status: z.string(),
  pinCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const ProjectListResponseSchema = z.object({
  projects: z.array(ProjectResponseSchema),
  total: z.number(),
  page: z.number(),
  limit: z.number(),
});

doc('GET', '/api/v1/projects', {
  summary: 'List projects',
  description: 'Returns a paginated list of projects the authenticated user has access to within their current organization. Supports search and status filtering.',
  tags: ['projects'],
  auth: 'bearer',
  query: ProjectQuerySchema,
  response: ProjectListResponseSchema,
  errors: [
    { status: 401, code: 'UNAUTHORIZED', description: 'Missing or invalid authentication' },
  ],
});

const ProjectCreateBodySchema = z.object({
  name: z.string(),
  url: z.string(),
  description: z.string().optional(),
});

doc('POST', '/api/v1/projects', {
  summary: 'Create a new project',
  description: 'Creates a new project in the user\'s current organization. The project URL is used to associate annotations captured via the browser extension or widget.',
  tags: ['projects'],
  auth: 'bearer',
  body: ProjectCreateBodySchema,
  response: ProjectResponseSchema,
  errors: [
    { status: 400, code: 'VALIDATION_ERROR', description: 'Invalid project payload' },
    { status: 401, code: 'UNAUTHORIZED', description: 'Missing or invalid authentication' },
    { status: 403, code: 'PLAN_LIMIT_EXCEEDED', description: 'Project limit reached for current billing plan' },
  ],
});

doc('GET', '/api/v1/projects/{id}', {
  summary: 'Get project details',
  description: 'Returns full details of a single project including metadata, member count, and annotation statistics.',
  tags: ['projects'],
  auth: 'bearer',
  response: ProjectResponseSchema,
  errors: [
    { status: 401, code: 'UNAUTHORIZED', description: 'Missing or invalid authentication' },
    { status: 403, code: 'FORBIDDEN', description: 'User does not have access to this project' },
    { status: 404, code: 'NOT_FOUND', description: 'Project not found' },
  ],
});

doc('DELETE', '/api/v1/projects/{id}', {
  summary: 'Delete a project',
  description: 'Permanently deletes a project and all its associated data (annotations, comments, screenshots). This action cannot be undone. Only project owners and org admins can delete projects.',
  tags: ['projects'],
  auth: 'bearer',
  response: z.object({ success: z.boolean() }),
  errors: [
    { status: 401, code: 'UNAUTHORIZED', description: 'Missing or invalid authentication' },
    { status: 403, code: 'FORBIDDEN', description: 'Only owners/admins can delete projects' },
    { status: 404, code: 'NOT_FOUND', description: 'Project not found' },
  ],
});

doc('POST', '/api/v1/projects/{id}/archive', {
  summary: 'Archive a project',
  description: 'Moves a project to archived status. Archived projects are hidden from default views but retain all data. Can be restored by updating the project status back to active.',
  tags: ['projects'],
  auth: 'bearer',
  response: z.object({ success: z.boolean() }),
  errors: [
    { status: 401, code: 'UNAUTHORIZED', description: 'Missing or invalid authentication' },
    { status: 403, code: 'FORBIDDEN', description: 'Insufficient permissions to archive this project' },
    { status: 404, code: 'NOT_FOUND', description: 'Project not found' },
  ],
});

// -----------------------------------------------------------------------------
// ANNOTATIONS ENDPOINTS
// -----------------------------------------------------------------------------

const AnnotationQuerySchema = z.object({
  page: z.number().optional(),
  limit: z.number().optional(),
  status: z.enum(['active', 'resolved', 'dismissed']).optional(),
  type: z.enum(['note', 'bug', 'suggestion']).optional(),
  assigneeId: z.string().optional(),
  severity: z.enum(['critical', 'major', 'minor', 'informational']).optional(),
});

const AnnotationResponseSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  pinNumber: z.number(),
  body: z.string(),
  type: z.string(),
  severity: z.string(),
  status: z.string(),
  target: z.object({ selector: z.string(), xpath: z.string().optional() }),
  environment: z.object({ url: z.string(), viewport: z.string().optional(), browser: z.string().optional() }),
  createdBy: z.string(),
  assigneeId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const AnnotationListResponseSchema = z.object({
  annotations: z.array(AnnotationResponseSchema),
  total: z.number(),
  page: z.number(),
  limit: z.number(),
});

doc('GET', '/api/v1/projects/{id}/annotations', {
  summary: 'List annotations for a project',
  description: 'Returns a paginated list of annotations (pins) belonging to the specified project. Supports filtering by status, type, assignee, and severity.',
  tags: ['annotations'],
  auth: 'bearer',
  query: AnnotationQuerySchema,
  response: AnnotationListResponseSchema,
  errors: [
    { status: 401, code: 'UNAUTHORIZED', description: 'Missing or invalid authentication' },
    { status: 403, code: 'FORBIDDEN', description: 'User does not have access to this project' },
    { status: 404, code: 'NOT_FOUND', description: 'Project not found' },
  ],
});

const AnnotationCreateBodySchema = z.object({
  body: z.string(),
  type: z.enum(['note', 'bug', 'suggestion']).optional(),
  severity: z.enum(['critical', 'major', 'minor', 'informational']).optional(),
  pageId: z.string().optional(),
  target: z.object({ selector: z.string(), xpath: z.string().optional() }),
  environment: z.object({ url: z.string(), viewport: z.string().optional(), browser: z.string().optional() }),
  assigneeId: z.string().optional(),
  dueDate: z.string().optional(),
  clientRequestId: z.string().optional(),
});

doc('POST', '/api/v1/projects/{id}/annotations', {
  summary: 'Create an annotation',
  description: 'Creates a new annotation (pin) on a project page. Automatically assigns a sequential pin number. Supports idempotency via clientRequestId to prevent duplicates from network retries.',
  tags: ['annotations'],
  auth: 'bearer',
  body: AnnotationCreateBodySchema,
  response: AnnotationResponseSchema,
  errors: [
    { status: 400, code: 'VALIDATION_ERROR', description: 'Invalid annotation payload' },
    { status: 401, code: 'UNAUTHORIZED', description: 'Missing or invalid authentication' },
    { status: 403, code: 'FORBIDDEN', description: 'User does not have access to this project' },
    { status: 404, code: 'NOT_FOUND', description: 'Project not found' },
    { status: 409, code: 'DUPLICATE_REQUEST', description: 'Annotation with this clientRequestId already exists' },
  ],
});

const AnnotationUpdateBodySchema = z.object({
  body: z.string().optional(),
  severity: z.enum(['critical', 'major', 'minor', 'informational']).optional(),
  assigneeId: z.string().optional(),
  dueDate: z.string().optional(),
});

doc('PATCH', '/api/v1/annotations/{id}', {
  summary: 'Update an annotation',
  description: 'Updates mutable fields of an existing annotation. Only the annotation creator or project members with edit access can update annotations.',
  tags: ['annotations'],
  auth: 'bearer',
  body: AnnotationUpdateBodySchema,
  response: AnnotationResponseSchema,
  errors: [
    { status: 400, code: 'VALIDATION_ERROR', description: 'Invalid update payload' },
    { status: 401, code: 'UNAUTHORIZED', description: 'Missing or invalid authentication' },
    { status: 403, code: 'FORBIDDEN', description: 'Insufficient permissions to edit this annotation' },
    { status: 404, code: 'NOT_FOUND', description: 'Annotation not found' },
  ],
});

doc('DELETE', '/api/v1/annotations/{id}', {
  summary: 'Delete an annotation',
  description: 'Permanently removes an annotation and its associated screenshot data. Only the annotation creator or project admins can delete annotations.',
  tags: ['annotations'],
  auth: 'bearer',
  response: z.object({ success: z.boolean() }),
  errors: [
    { status: 401, code: 'UNAUTHORIZED', description: 'Missing or invalid authentication' },
    { status: 403, code: 'FORBIDDEN', description: 'Insufficient permissions to delete this annotation' },
    { status: 404, code: 'NOT_FOUND', description: 'Annotation not found' },
  ],
});

const StatusChangeBodySchema = z.object({
  status: z.enum(['active', 'resolved', 'dismissed']),
  reason: z.string().optional(),
});

doc('POST', '/api/v1/annotations/{id}/status', {
  summary: 'Change annotation status',
  description: 'Transitions an annotation between statuses (active, resolved, dismissed). Triggers notifications to watchers and records the change in the activity log.',
  tags: ['annotations'],
  auth: 'bearer',
  body: StatusChangeBodySchema,
  response: AnnotationResponseSchema,
  errors: [
    { status: 400, code: 'INVALID_STATUS_TRANSITION', description: 'The requested status transition is not allowed' },
    { status: 401, code: 'UNAUTHORIZED', description: 'Missing or invalid authentication' },
    { status: 403, code: 'FORBIDDEN', description: 'Insufficient permissions to change status' },
    { status: 404, code: 'NOT_FOUND', description: 'Annotation not found' },
  ],
});

// -----------------------------------------------------------------------------
// COMMENTS ENDPOINTS
// -----------------------------------------------------------------------------

const CommentResponseSchema = z.object({
  id: z.string(),
  annotationId: z.string(),
  body: z.string(),
  createdBy: z.object({ id: z.string(), name: z.string(), email: z.string() }),
  createdAt: z.string(),
});

const CommentListResponseSchema = z.object({
  comments: z.array(CommentResponseSchema),
  total: z.number(),
});

doc('GET', '/api/v1/annotations/{id}/comments', {
  summary: 'List comments on an annotation',
  description: 'Returns all comments threaded on a specific annotation, ordered by creation date (oldest first).',
  tags: ['comments'],
  auth: 'bearer',
  response: CommentListResponseSchema,
  errors: [
    { status: 401, code: 'UNAUTHORIZED', description: 'Missing or invalid authentication' },
    { status: 403, code: 'FORBIDDEN', description: 'User does not have access to the parent project' },
    { status: 404, code: 'NOT_FOUND', description: 'Annotation not found' },
  ],
});

const CommentCreateBodySchema = z.object({
  body: z.string(),
});

doc('POST', '/api/v1/annotations/{id}/comments', {
  summary: 'Add a comment to an annotation',
  description: 'Posts a new comment on an annotation. Triggers notifications to the annotation creator and other commenters. Supports @mentions that generate targeted notifications.',
  tags: ['comments'],
  auth: 'bearer',
  body: CommentCreateBodySchema,
  response: CommentResponseSchema,
  errors: [
    { status: 400, code: 'VALIDATION_ERROR', description: 'Empty or invalid comment body' },
    { status: 401, code: 'UNAUTHORIZED', description: 'Missing or invalid authentication' },
    { status: 403, code: 'FORBIDDEN', description: 'User does not have access to the parent project' },
    { status: 404, code: 'NOT_FOUND', description: 'Annotation not found' },
  ],
});

// -----------------------------------------------------------------------------
// TEAMS ENDPOINTS
// -----------------------------------------------------------------------------

const TeamResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  memberCount: z.number(),
  createdAt: z.string(),
});

const TeamListResponseSchema = z.object({
  teams: z.array(TeamResponseSchema),
});

doc('GET', '/api/v1/teams', {
  summary: 'List teams',
  description: 'Returns all teams in the current organization that the authenticated user is a member of or has visibility into based on their role.',
  tags: ['teams'],
  auth: 'bearer',
  response: TeamListResponseSchema,
  errors: [
    { status: 401, code: 'UNAUTHORIZED', description: 'Missing or invalid authentication' },
  ],
});

const TeamCreateBodySchema = z.object({
  name: z.string(),
});

doc('POST', '/api/v1/teams', {
  summary: 'Create a team',
  description: 'Creates a new team in the current organization. The creating user is automatically added as the team owner.',
  tags: ['teams'],
  auth: 'bearer',
  body: TeamCreateBodySchema,
  response: TeamResponseSchema,
  errors: [
    { status: 400, code: 'VALIDATION_ERROR', description: 'Invalid team name' },
    { status: 401, code: 'UNAUTHORIZED', description: 'Missing or invalid authentication' },
    { status: 409, code: 'TEAM_NAME_EXISTS', description: 'A team with this name already exists in the organization' },
  ],
});

const AddMemberBodySchema = z.object({
  userId: z.string(),
  role: z.enum(['viewer', 'editor', 'admin']).optional(),
});

doc('POST', '/api/v1/teams/{id}/members', {
  summary: 'Add a member to a team',
  description: 'Invites a user to join the team with the specified role. The user must be a member of the same organization. Sends a notification to the invited user.',
  tags: ['teams'],
  auth: 'bearer',
  body: AddMemberBodySchema,
  response: z.object({ success: z.boolean() }),
  errors: [
    { status: 400, code: 'VALIDATION_ERROR', description: 'Invalid member payload' },
    { status: 401, code: 'UNAUTHORIZED', description: 'Missing or invalid authentication' },
    { status: 403, code: 'FORBIDDEN', description: 'Only team admins/owners can add members' },
    { status: 404, code: 'NOT_FOUND', description: 'Team or user not found' },
    { status: 409, code: 'ALREADY_MEMBER', description: 'User is already a member of this team' },
  ],
});

const UpdateMemberRoleBodySchema = z.object({
  role: z.enum(['viewer', 'editor', 'admin']),
});

doc('PATCH', '/api/v1/teams/{id}/members/{userId}', {
  summary: 'Update a team member\'s role',
  description: 'Changes the role of an existing team member. Only team owners and admins can change roles. Cannot demote the last owner.',
  tags: ['teams'],
  auth: 'bearer',
  body: UpdateMemberRoleBodySchema,
  response: z.object({ success: z.boolean() }),
  errors: [
    { status: 400, code: 'CANNOT_DEMOTE_LAST_OWNER', description: 'Cannot remove owner role from the last team owner' },
    { status: 401, code: 'UNAUTHORIZED', description: 'Missing or invalid authentication' },
    { status: 403, code: 'FORBIDDEN', description: 'Only team owners/admins can change roles' },
    { status: 404, code: 'NOT_FOUND', description: 'Team or member not found' },
  ],
});

doc('DELETE', '/api/v1/teams/{id}/members/{userId}', {
  summary: 'Remove a team member',
  description: 'Removes a user from the team. Team owners/admins can remove any member. Members can also remove themselves (leave the team). The last owner cannot be removed.',
  tags: ['teams'],
  auth: 'bearer',
  response: z.object({ success: z.boolean() }),
  errors: [
    { status: 400, code: 'CANNOT_REMOVE_LAST_OWNER', description: 'Cannot remove the last owner of a team' },
    { status: 401, code: 'UNAUTHORIZED', description: 'Missing or invalid authentication' },
    { status: 403, code: 'FORBIDDEN', description: 'Insufficient permissions to remove this member' },
    { status: 404, code: 'NOT_FOUND', description: 'Team or member not found' },
  ],
});

// -----------------------------------------------------------------------------
// SHARED LINKS ENDPOINTS
// -----------------------------------------------------------------------------

const SharedLinkCreateBodySchema = z.object({
  password: z.string().optional(),
  expiresAt: z.string().optional(),
  allowGuestAnnotations: z.boolean().optional(),
});

const SharedLinkResponseSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  linkId: z.string(),
  url: z.string(),
  passwordProtected: z.boolean(),
  allowGuestAnnotations: z.boolean(),
  expiresAt: z.string().optional(),
  createdAt: z.string(),
});

doc('POST', '/api/v1/projects/{id}/share', {
  summary: 'Create a shared link for a project',
  description: 'Generates a shareable link that allows external users to view project annotations without authentication. Optionally password-protected and time-limited. Can enable guest annotation capability.',
  tags: ['shared-links'],
  auth: 'bearer',
  body: SharedLinkCreateBodySchema,
  response: SharedLinkResponseSchema,
  errors: [
    { status: 401, code: 'UNAUTHORIZED', description: 'Missing or invalid authentication' },
    { status: 403, code: 'FORBIDDEN', description: 'Only project owners/admins can create shared links' },
    { status: 404, code: 'NOT_FOUND', description: 'Project not found' },
  ],
});

const SharedLinkVerifyBodySchema = z.object({
  password: z.string(),
});

doc('POST', '/api/v1/shared/{linkId}/verify', {
  summary: 'Verify shared link password',
  description: 'Validates the password for a password-protected shared link. On success, returns a time-limited access token for viewing the shared project.',
  tags: ['shared-links'],
  auth: 'none',
  body: SharedLinkVerifyBodySchema,
  response: z.object({ accessToken: z.string(), expiresAt: z.string() }),
  errors: [
    { status: 401, code: 'INVALID_PASSWORD', description: 'The provided password is incorrect' },
    { status: 404, code: 'NOT_FOUND', description: 'Shared link not found or expired' },
    { status: 429, code: 'AUTH_RATE_LIMIT', description: 'Too many verification attempts' },
  ],
});

// -----------------------------------------------------------------------------
// TAGS ENDPOINTS
// -----------------------------------------------------------------------------

const TagResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().optional(),
  projectId: z.string(),
  createdAt: z.string(),
});

const TagListResponseSchema = z.object({
  tags: z.array(TagResponseSchema),
});

doc('GET', '/api/v1/projects/{id}/tags', {
  summary: 'List project tags',
  description: 'Returns all tags defined for a project. Tags can be applied to annotations for categorization and filtering.',
  tags: ['tags'],
  auth: 'bearer',
  response: TagListResponseSchema,
  errors: [
    { status: 401, code: 'UNAUTHORIZED', description: 'Missing or invalid authentication' },
    { status: 403, code: 'FORBIDDEN', description: 'User does not have access to this project' },
    { status: 404, code: 'NOT_FOUND', description: 'Project not found' },
  ],
});

const TagCreateBodySchema = z.object({
  name: z.string(),
  color: z.string().optional(),
});

doc('POST', '/api/v1/projects/{id}/tags', {
  summary: 'Create a project tag',
  description: 'Creates a new tag for the specified project. Tag names must be unique within a project. Color is an optional hex string (e.g. "#ff5733").',
  tags: ['tags'],
  auth: 'bearer',
  body: TagCreateBodySchema,
  response: TagResponseSchema,
  errors: [
    { status: 400, code: 'VALIDATION_ERROR', description: 'Invalid tag payload' },
    { status: 401, code: 'UNAUTHORIZED', description: 'Missing or invalid authentication' },
    { status: 403, code: 'FORBIDDEN', description: 'Insufficient permissions' },
    { status: 404, code: 'NOT_FOUND', description: 'Project not found' },
    { status: 409, code: 'TAG_NAME_EXISTS', description: 'A tag with this name already exists in the project' },
  ],
});

doc('DELETE', '/api/v1/projects/{id}/tags/{tagId}', {
  summary: 'Delete a project tag',
  description: 'Removes a tag from the project. Any annotations currently using this tag will have it removed. This action cannot be undone.',
  tags: ['tags'],
  auth: 'bearer',
  response: z.object({ success: z.boolean() }),
  errors: [
    { status: 401, code: 'UNAUTHORIZED', description: 'Missing or invalid authentication' },
    { status: 403, code: 'FORBIDDEN', description: 'Insufficient permissions' },
    { status: 404, code: 'NOT_FOUND', description: 'Project or tag not found' },
  ],
});

const TagAssignBodySchema = z.object({
  tagIds: z.array(z.string()),
});

doc('PUT', '/api/v1/annotations/{annotationId}/tags', {
  summary: 'Set tags on an annotation',
  description: 'Replaces the complete set of tags on an annotation. Pass an empty array to remove all tags. Tag IDs must belong to the same project as the annotation.',
  tags: ['tags'],
  auth: 'bearer',
  body: TagAssignBodySchema,
  response: z.object({ tags: z.array(TagResponseSchema) }),
  errors: [
    { status: 400, code: 'INVALID_TAG_IDS', description: 'One or more tag IDs do not belong to this project' },
    { status: 401, code: 'UNAUTHORIZED', description: 'Missing or invalid authentication' },
    { status: 403, code: 'FORBIDDEN', description: 'Insufficient permissions to modify this annotation' },
    { status: 404, code: 'NOT_FOUND', description: 'Annotation not found' },
  ],
});

// -----------------------------------------------------------------------------
// ACTIVITY ENDPOINTS
// -----------------------------------------------------------------------------

const ActivityQuerySchema = z.object({
  page: z.number().optional(),
  limit: z.number().optional(),
  type: z.string().optional(),
});

const ActivityEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  actor: z.object({ id: z.string(), name: z.string() }),
  target: z.object({ type: z.string(), id: z.string(), label: z.string().optional() }),
  metadata: z.object({}).optional(),
  createdAt: z.string(),
});

const ActivityListResponseSchema = z.object({
  events: z.array(ActivityEventSchema),
  total: z.number(),
  page: z.number(),
  limit: z.number(),
});

doc('GET', '/api/v1/projects/{id}/activity', {
  summary: 'Get project activity feed',
  description: 'Returns a chronological feed of activity events for a project (annotation created, status changed, comments added, members joined, etc.). Useful for audit trails and team awareness.',
  tags: ['activity'],
  auth: 'bearer',
  query: ActivityQuerySchema,
  response: ActivityListResponseSchema,
  errors: [
    { status: 401, code: 'UNAUTHORIZED', description: 'Missing or invalid authentication' },
    { status: 403, code: 'FORBIDDEN', description: 'User does not have access to this project' },
    { status: 404, code: 'NOT_FOUND', description: 'Project not found' },
  ],
});

// -----------------------------------------------------------------------------
// BULK ENDPOINTS
// -----------------------------------------------------------------------------

const BulkAnnotationBodySchema = z.object({
  annotationIds: z.array(z.string()),
  action: z.enum(['resolve', 'dismiss', 'reopen', 'delete', 'assign', 'tag']),
  assigneeId: z.string().optional(),
  tagIds: z.array(z.string()).optional(),
});

const BulkResultSchema = z.object({
  processed: z.number(),
  failed: z.number(),
  errors: z.array(z.object({ id: z.string(), code: z.string(), message: z.string() })).optional(),
});

doc('POST', '/api/v1/projects/{id}/annotations/bulk', {
  summary: 'Bulk update annotations',
  description: 'Performs a batch operation on multiple annotations at once. Supported actions: resolve, dismiss, reopen, delete, assign (requires assigneeId), and tag (requires tagIds). Returns a summary of processed/failed items.',
  tags: ['bulk'],
  auth: 'bearer',
  body: BulkAnnotationBodySchema,
  response: BulkResultSchema,
  errors: [
    { status: 400, code: 'VALIDATION_ERROR', description: 'Invalid bulk payload or unsupported action' },
    { status: 401, code: 'UNAUTHORIZED', description: 'Missing or invalid authentication' },
    { status: 403, code: 'FORBIDDEN', description: 'Insufficient permissions for bulk operations' },
    { status: 404, code: 'NOT_FOUND', description: 'Project not found' },
  ],
});

// -----------------------------------------------------------------------------
// WEBHOOKS ENDPOINTS
// -----------------------------------------------------------------------------

const WebhookResponseSchema = z.object({
  id: z.string(),
  url: z.string(),
  events: z.array(z.string()),
  active: z.boolean(),
  secret: z.string(),
  createdAt: z.string(),
});

const WebhookListResponseSchema = z.object({
  webhooks: z.array(WebhookResponseSchema),
});

const WebhookCreateSchema = z.object({
  url: z.string(),
  events: z.array(z.string()),
});

doc('GET', '/api/v1/webhooks', {
  summary: 'List webhook endpoints',
  description: 'Returns all webhook endpoints configured for the current organization. Each webhook includes its target URL, subscribed events, and active status.',
  tags: ['webhooks'],
  auth: 'bearer',
  response: WebhookListResponseSchema,
  errors: [
    { status: 401, code: 'UNAUTHORIZED', description: 'Missing or invalid authentication' },
  ],
});

doc('POST', '/api/v1/webhooks', {
  summary: 'Register a webhook endpoint',
  description: 'Creates a new webhook endpoint that will receive HTTP POST notifications for the specified events. Returns the webhook including a signing secret used to verify payload authenticity. Supported events: annotation.created, annotation.updated, annotation.status_changed, comment.created, project.created, project.deleted.',
  tags: ['webhooks'],
  auth: 'bearer',
  body: WebhookCreateSchema,
  response: WebhookResponseSchema,
  errors: [
    { status: 400, code: 'VALIDATION_ERROR', description: 'Invalid webhook payload (missing URL or events)' },
    { status: 401, code: 'UNAUTHORIZED', description: 'Missing or invalid authentication' },
    { status: 403, code: 'PLAN_LIMIT_EXCEEDED', description: 'Webhook limit reached for current billing plan' },
  ],
});

doc('DELETE', '/api/v1/webhooks/{id}', {
  summary: 'Delete a webhook endpoint',
  description: 'Permanently removes a webhook endpoint. No further events will be delivered to this URL. In-flight deliveries may still complete.',
  tags: ['webhooks'],
  auth: 'bearer',
  response: z.object({ success: z.boolean() }),
  errors: [
    { status: 401, code: 'UNAUTHORIZED', description: 'Missing or invalid authentication' },
    { status: 404, code: 'NOT_FOUND', description: 'Webhook not found' },
  ],
});

// -----------------------------------------------------------------------------
// NOTIFICATIONS ENDPOINTS
// -----------------------------------------------------------------------------

const NotificationResponseSchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  body: z.string(),
  read: z.boolean(),
  link: z.string().optional(),
  createdAt: z.string(),
});

const NotificationListResponseSchema = z.object({
  notifications: z.array(NotificationResponseSchema),
  unreadCount: z.number(),
});

doc('GET', '/api/v1/notifications', {
  summary: 'List user notifications',
  description: 'Returns the authenticated user\'s notifications ordered by most recent first. Includes both read and unread notifications with an unread count summary.',
  tags: ['notifications'],
  auth: 'bearer',
  response: NotificationListResponseSchema,
  errors: [
    { status: 401, code: 'UNAUTHORIZED', description: 'Missing or invalid authentication' },
  ],
});

doc('PATCH', '/api/v1/notifications/{id}/read', {
  summary: 'Mark a notification as read',
  description: 'Marks a specific notification as read. The notification must belong to the authenticated user.',
  tags: ['notifications'],
  auth: 'bearer',
  response: z.object({ success: z.boolean() }),
  errors: [
    { status: 401, code: 'UNAUTHORIZED', description: 'Missing or invalid authentication' },
    { status: 404, code: 'NOT_FOUND', description: 'Notification not found or does not belong to user' },
  ],
});

// -----------------------------------------------------------------------------
// ORGANIZATION ENDPOINTS
// -----------------------------------------------------------------------------

const OrgResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  plan: z.string(),
  memberCount: z.number(),
  createdAt: z.string(),
});

doc('GET', '/api/v1/org', {
  summary: 'Get current organization',
  description: 'Returns details of the user\'s currently active organization, including plan information and member count.',
  tags: ['org'],
  auth: 'bearer',
  response: OrgResponseSchema,
  errors: [
    { status: 401, code: 'UNAUTHORIZED', description: 'Missing or invalid authentication' },
  ],
});

const OrgUpdateBodySchema = z.object({
  name: z.string().optional(),
  slug: z.string().optional(),
});

doc('PATCH', '/api/v1/org', {
  summary: 'Update organization settings',
  description: 'Updates the current organization\'s name or slug. Only organization owners and admins can perform this action. Slug must be globally unique.',
  tags: ['org'],
  auth: 'bearer',
  body: OrgUpdateBodySchema,
  response: OrgResponseSchema,
  errors: [
    { status: 400, code: 'VALIDATION_ERROR', description: 'Invalid organization payload' },
    { status: 401, code: 'UNAUTHORIZED', description: 'Missing or invalid authentication' },
    { status: 403, code: 'FORBIDDEN', description: 'Only org owners/admins can update settings' },
    { status: 409, code: 'SLUG_TAKEN', description: 'The requested slug is already in use' },
  ],
});

const OrgInviteBodySchema = z.object({
  email: z.string(),
  role: z.enum(['member', 'admin']).optional(),
});

doc('POST', '/api/v1/org/invitations', {
  summary: 'Invite a user to the organization',
  description: 'Sends an email invitation to join the organization. If the email is already registered, they can accept immediately. Otherwise they will be prompted to create an account first.',
  tags: ['org'],
  auth: 'bearer',
  body: OrgInviteBodySchema,
  response: z.object({ invitation: z.object({ id: z.string(), email: z.string(), status: z.string() }) }),
  errors: [
    { status: 400, code: 'VALIDATION_ERROR', description: 'Invalid invitation payload' },
    { status: 401, code: 'UNAUTHORIZED', description: 'Missing or invalid authentication' },
    { status: 403, code: 'FORBIDDEN', description: 'Only org admins can send invitations' },
    { status: 409, code: 'ALREADY_MEMBER', description: 'User is already a member of this organization' },
  ],
});

const OrgSwitchBodySchema = z.object({
  orgId: z.string(),
});

doc('POST', '/api/v1/org/switch', {
  summary: 'Switch active organization',
  description: 'Changes the user\'s active organization context. The user must be a member of the target organization. Subsequent requests will operate in the context of the new organization.',
  tags: ['org'],
  auth: 'bearer',
  body: OrgSwitchBodySchema,
  response: z.object({ org: OrgResponseSchema, token: z.string() }),
  errors: [
    { status: 401, code: 'UNAUTHORIZED', description: 'Missing or invalid authentication' },
    { status: 403, code: 'NOT_A_MEMBER', description: 'User is not a member of the target organization' },
    { status: 404, code: 'NOT_FOUND', description: 'Organization not found' },
  ],
});

// -----------------------------------------------------------------------------
// API KEYS ENDPOINTS
// -----------------------------------------------------------------------------

const ApiKeyResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  lastUsedAt: z.string().optional(),
  createdAt: z.string(),
});

const ApiKeyListResponseSchema = z.object({
  keys: z.array(ApiKeyResponseSchema),
});

doc('GET', '/api/v1/api-keys', {
  summary: 'List API keys',
  description: 'Returns all API keys for the current organization. Keys are shown with their prefix (first 8 chars) for identification. The full key value is only returned at creation time.',
  tags: ['api-keys'],
  auth: 'bearer',
  response: ApiKeyListResponseSchema,
  errors: [
    { status: 401, code: 'UNAUTHORIZED', description: 'Missing or invalid authentication' },
    { status: 403, code: 'FORBIDDEN', description: 'Only org admins can manage API keys' },
  ],
});

const ApiKeyCreateBodySchema = z.object({
  name: z.string(),
  scopes: z.array(z.string()).optional(),
});

const ApiKeyCreatedResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  key: z.string(),
  prefix: z.string(),
  createdAt: z.string(),
});

doc('POST', '/api/v1/api-keys', {
  summary: 'Create an API key',
  description: 'Generates a new API key for programmatic access. The full key (pk_...) is returned only once in the response and cannot be retrieved later. Store it securely. Optional scopes restrict what the key can access.',
  tags: ['api-keys'],
  auth: 'bearer',
  body: ApiKeyCreateBodySchema,
  response: ApiKeyCreatedResponseSchema,
  errors: [
    { status: 400, code: 'VALIDATION_ERROR', description: 'Invalid API key payload' },
    { status: 401, code: 'UNAUTHORIZED', description: 'Missing or invalid authentication' },
    { status: 403, code: 'FORBIDDEN', description: 'Only org admins can create API keys' },
    { status: 403, code: 'PLAN_LIMIT_EXCEEDED', description: 'API key limit reached for current plan' },
  ],
});

doc('DELETE', '/api/v1/api-keys/{id}', {
  summary: 'Revoke an API key',
  description: 'Permanently revokes an API key. Any requests using this key will immediately receive 401 responses. This action cannot be undone.',
  tags: ['api-keys'],
  auth: 'bearer',
  response: z.object({ success: z.boolean() }),
  errors: [
    { status: 401, code: 'UNAUTHORIZED', description: 'Missing or invalid authentication' },
    { status: 403, code: 'FORBIDDEN', description: 'Only org admins can revoke API keys' },
    { status: 404, code: 'NOT_FOUND', description: 'API key not found' },
  ],
});

// -----------------------------------------------------------------------------
// AUDIT LOG ENDPOINTS
// -----------------------------------------------------------------------------

const AuditLogQuerySchema = z.object({
  page: z.number().optional(),
  limit: z.number().optional(),
  actorId: z.string().optional(),
  action: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
});

const AuditLogEntrySchema = z.object({
  id: z.string(),
  action: z.string(),
  actor: z.object({ id: z.string(), name: z.string(), email: z.string() }),
  target: z.object({ type: z.string(), id: z.string() }).optional(),
  metadata: z.object({}).optional(),
  ipAddress: z.string().optional(),
  createdAt: z.string(),
});

const AuditLogResponseSchema = z.object({
  entries: z.array(AuditLogEntrySchema),
  total: z.number(),
  page: z.number(),
  limit: z.number(),
});

doc('GET', '/api/v1/org/audit-log', {
  summary: 'Query organization audit log',
  description: 'Returns a paginated, filterable audit trail of security-sensitive and administrative actions within the organization. Includes user management, API key operations, project deletions, and configuration changes.',
  tags: ['audit-log'],
  auth: 'bearer',
  query: AuditLogQuerySchema,
  response: AuditLogResponseSchema,
  errors: [
    { status: 401, code: 'UNAUTHORIZED', description: 'Missing or invalid authentication' },
    { status: 403, code: 'FORBIDDEN', description: 'Only org owners/admins can access audit logs' },
  ],
});

// -----------------------------------------------------------------------------
// WIDGET ENDPOINTS
// -----------------------------------------------------------------------------

const WidgetFeedbackBodySchema = z.object({
  projectId: z.string(),
  pageUrl: z.string(),
  body: z.string(),
  type: z.enum(['note', 'bug', 'suggestion']).optional(),
  severity: z.enum(['critical', 'major', 'minor', 'informational']).optional(),
  target: z.object({ selector: z.string(), xpath: z.string().optional() }),
  environment: z.object({ url: z.string(), viewport: z.string().optional(), browser: z.string().optional(), userAgent: z.string().optional() }),
  screenshot: z.string().optional(),
  metadata: z.object({}).optional(),
});

doc('POST', '/api/v1/widget/feedback', {
  summary: 'Submit feedback via embedded widget',
  description: 'Receives feedback submitted through the Pinpoint embeddable widget. Authenticates via API key (associated with the project). Automatically creates an annotation with the submitted data and optional screenshot.',
  tags: ['widget'],
  auth: 'api-key',
  body: WidgetFeedbackBodySchema,
  response: z.object({ id: z.string(), pinNumber: z.number() }),
  errors: [
    { status: 400, code: 'VALIDATION_ERROR', description: 'Invalid feedback payload' },
    { status: 401, code: 'INVALID_API_KEY', description: 'Missing or invalid API key' },
    { status: 404, code: 'PROJECT_NOT_FOUND', description: 'Project associated with the API key not found' },
  ],
});

// -----------------------------------------------------------------------------
// GUEST FEEDBACK ENDPOINTS
// -----------------------------------------------------------------------------

const GuestFeedbackBodySchema = z.object({
  body: z.string(),
  guestName: z.string().optional(),
  guestEmail: z.string().optional(),
  type: z.enum(['note', 'bug', 'suggestion']).optional(),
  severity: z.enum(['critical', 'major', 'minor', 'informational']).optional(),
  target: z.object({ selector: z.string(), xpath: z.string().optional() }),
  environment: z.object({ url: z.string(), viewport: z.string().optional(), browser: z.string().optional() }),
  screenshot: z.string().optional(),
});

doc('POST', '/api/v1/shared/{linkId}/feedback', {
  summary: 'Submit guest feedback via shared link',
  description: 'Allows unauthenticated users with access to a shared link (that has guest annotations enabled) to submit feedback. The shared link must have allowGuestAnnotations set to true. If the link is password-protected, the access token from verify must be provided.',
  tags: ['guest-feedback'],
  auth: 'none',
  body: GuestFeedbackBodySchema,
  response: z.object({ id: z.string(), pinNumber: z.number() }),
  errors: [
    { status: 400, code: 'VALIDATION_ERROR', description: 'Invalid feedback payload' },
    { status: 403, code: 'GUEST_ANNOTATIONS_DISABLED', description: 'This shared link does not allow guest annotations' },
    { status: 404, code: 'NOT_FOUND', description: 'Shared link not found or expired' },
  ],
});
