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
  description?: string;
  body?: z.ZodType;
  query?: z.ZodType;
  response?: z.ZodType;
  tags?: string[];
  auth?: 'bearer' | 'api-key' | 'none';
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
      summary: endpoint.description ?? `${endpoint.method} ${endpoint.path}`,
      tags: endpoint.tags ?? [endpoint.path.split('/')[3] ?? 'general'],
      responses: { '200': { description: 'Success' } },
    };

    if (endpoint.auth !== 'none') {
      operation.security = [{ [endpoint.auth === 'api-key' ? 'ApiKey' : 'Bearer']: [] }];
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

    paths[endpoint.path][method] = operation;
  }

  return {
    openapi: '3.0.3',
    info: { title: 'Pinpoint API', version: '1.0.0', description: 'Pinpoint public API documentation' },
    servers: [{ url: '/api/v1' }],
    components: {
      securitySchemes: {
        Bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        ApiKey: { type: 'apiKey', in: 'header', name: 'Authorization', description: 'Bearer pk_...' },
      },
    },
    paths,
  };
}

export function serveApiDocs(_req: Request, res: Response): void {
  res.json(buildSpec());
}

// Pre-register the public API endpoints with their schemas
const FeedbackQuerySchema = z.object({
  projectId: z.string(),
  page: z.coerce.number().optional(),
  limit: z.coerce.number().optional(),
  status: z.enum(['active', 'resolved', 'dismissed']).optional(),
});

const FeedbackCreateSchema = z.object({
  projectId: z.string(),
  pageId: z.string().optional(),
  type: z.enum(['note', 'bug', 'suggestion']).optional(),
  severity: z.enum(['critical', 'major', 'minor', 'informational']).optional(),
  body: z.string().min(1),
  target: z.object({ selector: z.string(), xpath: z.string().optional() }),
  environment: z.object({ url: z.string(), viewport: z.string().optional(), browser: z.string().optional() }),
});

const FeedbackUpdateSchema = z.object({
  body: z.string().optional(),
  severity: z.enum(['critical', 'major', 'minor', 'informational']).optional(),
  status: z.enum(['active', 'resolved', 'dismissed']).optional(),
  assigneeId: z.string().uuid().optional(),
  dueDate: z.string().optional(),
});

const WebhookCreateSchema = z.object({
  url: z.string().url(),
  events: z.array(z.string()).min(1),
});

doc('GET', '/api/v1/feedback', { query: FeedbackQuerySchema, description: 'List feedback (paginated)', tags: ['feedback'], auth: 'api-key' });
doc('POST', '/api/v1/feedback', { body: FeedbackCreateSchema, description: 'Create feedback', tags: ['feedback'], auth: 'api-key' });
doc('PATCH', '/api/v1/feedback/{id}', { body: FeedbackUpdateSchema, description: 'Update feedback', tags: ['feedback'], auth: 'api-key' });
doc('DELETE', '/api/v1/feedback/{id}', { description: 'Delete feedback', tags: ['feedback'], auth: 'api-key' });
doc('POST', '/api/v1/webhooks', { body: WebhookCreateSchema, description: 'Register webhook endpoint', tags: ['webhooks'], auth: 'bearer' });
doc('GET', '/api/v1/webhooks', { description: 'List webhook endpoints', tags: ['webhooks'], auth: 'bearer' });
doc('DELETE', '/api/v1/webhooks/{id}', { description: 'Delete webhook endpoint', tags: ['webhooks'], auth: 'bearer' });
doc('GET', '/api/v1/notifications', { description: 'List user notifications', tags: ['notifications'], auth: 'bearer' });
doc('POST', '/api/v1/notifications/read-all', { description: 'Mark all notifications as read', tags: ['notifications'], auth: 'bearer' });
