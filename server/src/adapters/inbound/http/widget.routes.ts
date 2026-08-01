// Widget feedback endpoint — public (no auth middleware), rate-limited.
//
// Accepts feedback submissions from the embeddable widget. Authenticates
// via an X-Project-Key header validated against the `api_keys` table
// (scoped to keys with 'widget' in their scopes).

import { Router, type Request, type Response } from 'express';
import { createHash } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import type { Knex } from 'knex';
import type { ApiKeyRepo } from '../../../domain/org/ports/ApiKeyRepo.js';
import type { AnnotationRepo } from '../../../domain/annotation/ports/AnnotationRepo.js';
import { parseUserAgent } from '@pinpoint/shared';

export interface WidgetRouteDeps {
  apiKeyRepo: ApiKeyRepo;
  annotationRepo: AnnotationRepo;
  db: Knex;
}

export function createWidgetRoutes(deps: WidgetRouteDeps): Router {
  const router = Router();
  const { apiKeyRepo, annotationRepo, db } = deps;

  // Rate limit: 5 requests per minute per IP
  const widgetLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many feedback submissions. Please try again later.',
        details: {},
      },
    },
  });

  // POST /api/v1/widget/feedback
  router.post('/feedback', widgetLimiter, async (req: Request, res: Response) => {
    // Validate X-Project-Key header
    const projectKey = req.headers['x-project-key'] as string | undefined;
    if (!projectKey) {
      return res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'X-Project-Key header is required.',
          details: {},
        },
      });
    }

    // Hash the key and look it up
    const keyHash = createHash('sha256').update(projectKey).digest('hex');
    const apiKey = await apiKeyRepo.findByHash(keyHash);

    if (!apiKey) {
      return res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid project key.',
          details: {},
        },
      });
    }

    // Verify the key has 'widget' scope
    if (!apiKey.scopes.includes('widget')) {
      return res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'API key does not have widget scope.',
          details: {},
        },
      });
    }

    // Validate request body
    const { description, severity, email, pageUrl, viewport, userAgent } = req.body;

    if (!description || typeof description !== 'string' || description.trim().length === 0) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION',
          message: 'description is required.',
          details: {},
        },
      });
    }

    if (!pageUrl || typeof pageUrl !== 'string') {
      return res.status(400).json({
        error: {
          code: 'VALIDATION',
          message: 'pageUrl is required.',
          details: {},
        },
      });
    }

    if (!viewport || typeof viewport.width !== 'number' || typeof viewport.height !== 'number') {
      return res.status(400).json({
        error: {
          code: 'VALIDATION',
          message: 'viewport with width and height is required.',
          details: {},
        },
      });
    }

    if (!userAgent || typeof userAgent !== 'string') {
      return res.status(400).json({
        error: {
          code: 'VALIDATION',
          message: 'userAgent is required.',
          details: {},
        },
      });
    }

    const validSeverities = ['critical', 'major', 'minor', 'informational'] as const;
    const resolvedSeverity = validSeverities.includes(severity as any)
      ? (severity as (typeof validSeverities)[number])
      : 'informational';

    // Find the first project belonging to this org
    const project = await db('projects')
      .where({ org_id: apiKey.orgId, status: 'active' })
      .orderBy('created_at', 'asc')
      .first();

    if (!project) {
      return res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: 'No active projects found for this key.',
          details: {},
        },
      });
    }

    // Parse the user agent string for structured environment metadata
    const ua = parseUserAgent(userAgent);

    const annotation = await annotationRepo.insert({
      projectId: project.id,
      pageId: project.id, // Widget submissions don't target a specific page
      type: 'note',
      severity: resolvedSeverity,
      status: 'active',
      body: email
        ? `${description.trim()}\n\n---\nSubmitted via widget\nContact: ${email}`
        : `${description.trim()}\n\n---\nSubmitted via widget`,
      authorId: 'guest',
      target: {
        cssSelector: 'body',
        xpath: '/html/body',
        pageX: 0,
        pageY: 0,
        tagName: 'BODY',
        textSnippet: 'Widget submission',
      },
      environment: {
        browserFamily: ua.browserFamily,
        browserVersion: ua.browserVersion,
        osFamily: ua.osFamily,
        osVersion: ua.osVersion,
        deviceType: ua.deviceType,
        userAgentRaw: userAgent,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
      },
      pinNumber: 0, // Auto-assigned by full flow; placeholder for widget
      orgId: apiKey.orgId,
    });

    // Update API key last-used timestamp
    await apiKeyRepo.updateLastUsed(apiKey.id);

    res.status(201).json({ data: { id: annotation.id } });
  });

  return router;
}
