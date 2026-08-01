// Guest feedback route — public (no auth), rate-limited.
//
// Allows guests to submit feedback on shared project links without
// registration. Validates that the shared link exists and has
// `allow_feedback = true` before accepting the submission.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { paramString } from './errors.js';
import type { AnnotationRepo } from '../../../domain/annotation/ports/AnnotationRepo.js';
import type { SharedLinkRepo } from '../../../domain/sharedLink/ports/SharedLinkRepo.js';
import type { PageRepo } from '../../../domain/project/ports/PageRepo.js';

export interface GuestFeedbackRouteDeps {
  annotationRepo: AnnotationRepo;
  sharedLinkRepo: SharedLinkRepo;
  pageRepo: PageRepo;
}

const GuestFeedbackBodySchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email().max(255).optional(),
  description: z.string().min(1).max(5000),
  severity: z.enum(['critical', 'major', 'minor', 'informational']).optional(),
  pageUrl: z.string().url().max(2000),
});

export function createGuestFeedbackRoutes(deps: GuestFeedbackRouteDeps): Router {
  const router = Router();
  const { annotationRepo, sharedLinkRepo, pageRepo } = deps;

  // Rate limit: 5 requests per hour per IP
  const guestFeedbackLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
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

  // POST /api/v1/shared/:linkId/feedback — public guest feedback submission
  router.post(
    '/:linkId/feedback',
    guestFeedbackLimiter,
    async (req: Request, res: Response) => {
      const linkId = paramString(req.params.linkId);
      if (!linkId) {
        return res.status(400).json({
          error: { code: 'VALIDATION', message: 'linkId parameter is required.' },
        });
      }

      // Validate the shared link exists
      const link = await sharedLinkRepo.findById(linkId);
      if (!link) {
        return res.status(404).json({
          error: { code: 'NOT_FOUND', message: 'Shared link not found.' },
        });
      }

      // Validate allow_feedback is enabled
      if (!link.allowFeedback) {
        return res.status(403).json({
          error: { code: 'FORBIDDEN', message: 'Feedback is not enabled for this shared link.' },
        });
      }

      // Validate body
      const parsed = GuestFeedbackBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: 'Invalid feedback payload.',
          issues: parsed.error.flatten(),
        });
      }

      const { name, email, description, severity, pageUrl } = parsed.data;

      // Lookup or create the page for this URL
      let page = await pageRepo.findByProjectAndUrl(link.projectId, pageUrl);
      if (!page) {
        page = await pageRepo.insert({
          projectId: link.projectId,
          url: pageUrl,
          title: null,
        });
      }

      // Create the annotation as a guest submission
      const annotation = await annotationRepo.insert({
        projectId: link.projectId,
        pageId: page.id,
        type: 'note',
        severity: severity ?? 'informational',
        status: 'active',
        body: description,
        authorId: 'guest', // No real user; marker for guest submissions
        target: {
          cssSelector: '',
          xpath: '',
          pageX: 0,
          pageY: 0,
          tagName: 'body',
          textSnippet: '',
        },
        environment: {
          browserFamily: 'unknown',
          browserVersion: null,
          osFamily: 'unknown',
          osVersion: null,
          deviceType: 'desktop',
          userAgentRaw: req.headers['user-agent'] || '',
        },
        pinNumber: 0, // Guest feedback does not allocate pin numbers
        isGuest: true,
        guestName: name,
        guestEmail: email ?? null,
      });

      res.status(201).json({
        data: {
          id: annotation.id,
          projectId: annotation.projectId,
          description: annotation.body,
          severity: annotation.severity,
          guestName: annotation.guestName,
          isGuest: annotation.isGuest,
          createdAt: annotation.createdAt,
        },
      });
    },
  );

  return router;
}
