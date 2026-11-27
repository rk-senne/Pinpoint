// MCP tool registry + dispatcher (Mission C5).
//
// Few, deep tools over the Pinpoint REST API. Each tool declares a JSON
// Schema `inputSchema` (as required by MCP `tools/list`) and a handler that
// validates its arguments and calls the `PinpointClient`.
//
// Input validation is done by a tiny hand-rolled validator (no Zod dependency
// in this leaf workspace) so the server stays dependency-free and the MCP
// protocol layer can run with or without the official SDK.

import type { PinpointClient } from './client.js';

/** JSON-Schema-ish shape we hand to MCP `tools/list`. */
export interface ToolInputSchema {
  type: 'object';
  properties: Record<string, { type: string; description?: string; enum?: string[] }>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  handler: (client: PinpointClient, args: Record<string, unknown>) => Promise<unknown>;
}

/** Raised when tool arguments fail validation. */
export class ToolValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolValidationError';
  }
}

const STATUS_VALUES = ['active', 'in_progress', 'resolved'] as const;
const SEVERITY_VALUES = ['critical', 'major', 'minor', 'informational'] as const;

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new ToolValidationError(`"${key}" is required and must be a non-empty string.`);
  }
  return v;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') {
    throw new ToolValidationError(`"${key}" must be a string.`);
  }
  return v;
}

function optionalEnum(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
): string | undefined {
  const v = optionalString(args, key);
  if (v === undefined) return undefined;
  if (!allowed.includes(v)) {
    throw new ToolValidationError(`"${key}" must be one of: ${allowed.join(', ')}.`);
  }
  return v;
}

function requireEnum(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
): string {
  const v = requireString(args, key);
  if (!allowed.includes(v)) {
    throw new ToolValidationError(`"${key}" must be one of: ${allowed.join(', ')}.`);
  }
  return v;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    throw new ToolValidationError(`"${key}" must be a positive number.`);
  }
  return v;
}

export const TOOLS: ToolDefinition[] = [
  {
    name: 'list_projects',
    description:
      'List the Pinpoint projects visible to the configured API key. Optional free-text search and active/archived status filter.',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Free-text project-name filter.' },
        status: { type: 'string', description: 'Project status.', enum: ['active', 'archived'] },
      },
      additionalProperties: false,
    },
    handler: (client, args) =>
      client.listProjects({
        ...(optionalString(args, 'search') !== undefined ? { search: optionalString(args, 'search') } : {}),
        ...(optionalEnum(args, 'status', ['active', 'archived']) !== undefined
          ? { status: optionalEnum(args, 'status', ['active', 'archived']) }
          : {}),
      }),
  },
  {
    name: 'list_feedback',
    description:
      'List feedback (annotations) for a project, with optional status and severity filters and pagination.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'The project id.' },
        status: { type: 'string', description: 'Status filter.', enum: [...STATUS_VALUES] },
        severity: { type: 'string', description: 'Severity filter.', enum: [...SEVERITY_VALUES] },
        page: { type: 'number', description: 'Page number (1-based).' },
        limit: { type: 'number', description: 'Items per page (max 100).' },
      },
      required: ['projectId'],
      additionalProperties: false,
    },
    handler: (client, args) =>
      client.listFeedback({
        projectId: requireString(args, 'projectId'),
        ...(optionalEnum(args, 'status', STATUS_VALUES) !== undefined
          ? { status: optionalEnum(args, 'status', STATUS_VALUES) }
          : {}),
        ...(optionalEnum(args, 'severity', SEVERITY_VALUES) !== undefined
          ? { severity: optionalEnum(args, 'severity', SEVERITY_VALUES) }
          : {}),
        ...(optionalNumber(args, 'page') !== undefined ? { page: optionalNumber(args, 'page') } : {}),
        ...(optionalNumber(args, 'limit') !== undefined ? { limit: optionalNumber(args, 'limit') } : {}),
      }),
  },
  {
    name: 'get_feedback',
    description:
      'Get a single feedback item by id (within its project), including its comment thread and any captured diagnostics (console/network/environment).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The feedback (annotation) id.' },
        projectId: { type: 'string', description: 'The id of the project the feedback belongs to.' },
      },
      required: ['id', 'projectId'],
      additionalProperties: false,
    },
    handler: (client, args) =>
      client.getFeedback({
        id: requireString(args, 'id'),
        projectId: requireString(args, 'projectId'),
      }),
  },
  {
    name: 'update_feedback_status',
    description: 'Change the status of a feedback item (active, in_progress, resolved).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The feedback (annotation) id.' },
        status: { type: 'string', description: 'The new status.', enum: [...STATUS_VALUES] },
      },
      required: ['id', 'status'],
      additionalProperties: false,
    },
    handler: (client, args) =>
      client.updateFeedbackStatus({
        id: requireString(args, 'id'),
        status: requireEnum(args, 'status', STATUS_VALUES),
      }),
  },
  {
    name: 'add_comment',
    description: 'Add a comment to a feedback item.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The feedback (annotation) id.' },
        body: { type: 'string', description: 'The comment text.' },
      },
      required: ['id', 'body'],
      additionalProperties: false,
    },
    handler: (client, args) =>
      client.addComment({
        id: requireString(args, 'id'),
        body: requireString(args, 'body'),
      }),
  },
];

/** Look up a tool definition by name. */
export function findTool(name: string): ToolDefinition | undefined {
  return TOOLS.find((t) => t.name === name);
}

/**
 * The `tools/list` payload: name + description + inputSchema for each tool
 * (handlers stripped).
 */
export function listTools(): Array<Omit<ToolDefinition, 'handler'>> {
  return TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

/**
 * Validate + execute a tool call. Returns the raw JSON result from the REST
 * API. Throws `ToolValidationError` for an unknown tool or bad arguments.
 */
export async function callTool(
  client: PinpointClient,
  name: string,
  args: Record<string, unknown> | undefined,
): Promise<unknown> {
  const tool = findTool(name);
  if (!tool) {
    throw new ToolValidationError(`Unknown tool: ${name}`);
  }
  return tool.handler(client, args ?? {});
}
