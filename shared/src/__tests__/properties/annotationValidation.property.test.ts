// Feature: pinpoint-app, Property 8: Malformed annotation request validation
// **Validates: Requirements 13.5**

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { AnnotationSchema } from '../../schemas.js';

// --- Arbitraries for invalid annotation payloads ---

/** Valid ISO 8601 date string for use in otherwise-valid fields */
const validIso = '2024-06-15T12:00:00.000Z';

/** A valid DOMTarget for use in otherwise-valid payloads */
const validTarget = {
  cssSelector: 'div > p',
  xpath: '/html/body/div/p',
  pageX: 100,
  pageY: 200,
  tagName: 'P',
  textSnippet: 'Hello',
};

/** A valid EnvironmentMetadata for use in otherwise-valid payloads (Req 17.3) */
const validEnvironment = {
  browserFamily: 'Chrome' as const,
  browserVersion: '124.0.6367.91',
  osFamily: 'macOS' as const,
  osVersion: '14.5',
  deviceType: 'desktop' as const,
  userAgentRaw: 'Mozilla/5.0 ...',
};

/** A complete valid annotation base (all required fields present and correct) */
const validBase = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  projectId: '550e8400-e29b-41d4-a716-446655440001',
  pageId: '550e8400-e29b-41d4-a716-446655440003',
  type: 'note',
  severity: 'minor',
  status: 'active',
  body: 'Some feedback',
  authorId: '550e8400-e29b-41d4-a716-446655440002',
  createdAt: validIso,
  updatedAt: validIso,
  target: validTarget,
  environment: validEnvironment,
  pinNumber: 1,
};

const requiredFields = [
  'id', 'projectId', 'pageId', 'type', 'severity', 'status',
  'body', 'authorId', 'createdAt', 'updatedAt', 'target', 'environment', 'pinNumber',
] as const;

/** Arbitrary that removes one or more required fields from a valid annotation */
const arbMissingRequiredFields = fc
  .subarray([...requiredFields], { minLength: 1 })
  .map((fieldsToRemove) => {
    const obj = { ...validBase };
    for (const field of fieldsToRemove) {
      delete (obj as Record<string, unknown>)[field];
    }
    return obj;
  });

/** Arbitrary that replaces fields with wrong types */
const arbWrongTypeFields = fc.oneof(
  // severity not in allowed enum
  fc.string({ minLength: 1 })
    .filter((s) => !['critical', 'major', 'minor', 'informational'].includes(s))
    .map((badSeverity) => ({ ...validBase, severity: badSeverity })),
  // type not in allowed enum
  fc.string({ minLength: 1 })
    .filter((s) => !['note', 'suggestion', 'guideline'].includes(s))
    .map((badType) => ({ ...validBase, type: badType })),
  // status not in allowed enum
  fc.string({ minLength: 1 })
    .filter((s) => !['active', 'in_progress', 'resolved'].includes(s))
    .map((badStatus) => ({ ...validBase, status: badStatus })),
  // body not a string
  fc.oneof(fc.integer(), fc.boolean(), fc.constant(null), fc.array(fc.integer()))
    .map((badBody) => ({ ...validBase, body: badBody })),
  // pinNumber not an integer (use a float)
  fc.double({ min: 0.01, max: 1000, noNaN: true, noDefaultInfinity: true })
    .filter((n) => !Number.isInteger(n))
    .map((badPin) => ({ ...validBase, pinNumber: badPin })),
  // pinNumber as a string
  fc.string().map((s) => ({ ...validBase, pinNumber: s })),
  // id not a string
  fc.integer().map((n) => ({ ...validBase, id: n })),
  // createdAt not a valid ISO 8601 date
  fc.constant({ ...validBase, createdAt: 'not-a-date' }),
  // updatedAt not a valid ISO 8601 date
  fc.constant({ ...validBase, updatedAt: 'invalid-timestamp' }),
);

/** Arbitrary that provides invalid target sub-fields */
const arbInvalidTarget = fc.oneof(
  // target missing required sub-fields
  fc.subarray(['cssSelector', 'xpath', 'pageX', 'pageY', 'tagName', 'textSnippet'], { minLength: 1 })
    .map((fieldsToRemove) => {
      const t = { ...validTarget };
      for (const f of fieldsToRemove) {
        delete (t as Record<string, unknown>)[f];
      }
      return { ...validBase, target: t };
    }),
  // target with wrong types for sub-fields
  fc.constant({ ...validBase, target: { ...validTarget, pageX: 'not-a-number' } }),
  fc.constant({ ...validBase, target: { ...validTarget, cssSelector: 123 } }),
  fc.constant({ ...validBase, target: { ...validTarget, tagName: false } }),
  // target is not an object at all
  fc.oneof(fc.string(), fc.integer(), fc.constant(null), fc.constant(undefined))
    .map((badTarget) => ({ ...validBase, target: badTarget })),
);

/** Arbitrary that provides invalid environment sub-fields (Req 17.3) */
const arbInvalidEnvironment = fc.oneof(
  // environment missing required sub-fields
  fc.subarray(
    ['browserFamily', 'browserVersion', 'osFamily', 'osVersion', 'deviceType', 'userAgentRaw'],
    { minLength: 1 },
  ).map((fieldsToRemove) => {
    const e = { ...validEnvironment } as Record<string, unknown>;
    for (const f of fieldsToRemove) {
      delete e[f];
    }
    return { ...validBase, environment: e };
  }),
  // environment.browserFamily not in closed enum
  fc.string({ minLength: 1 })
    .filter((s) => !['Chrome', 'Edge', 'Safari', 'Firefox', 'Opera', 'Brave', 'Arc', 'Other', 'unknown'].includes(s))
    .map((bad) => ({ ...validBase, environment: { ...validEnvironment, browserFamily: bad } })),
  // environment.osFamily not in closed enum
  fc.string({ minLength: 1 })
    .filter((s) => !['macOS', 'Windows', 'Linux', 'iOS', 'Android', 'ChromeOS', 'Other', 'unknown'].includes(s))
    .map((bad) => ({ ...validBase, environment: { ...validEnvironment, osFamily: bad } })),
  // environment.deviceType not in closed enum
  fc.string({ minLength: 1 })
    .filter((s) => !['desktop', 'tablet', 'mobile'].includes(s))
    .map((bad) => ({ ...validBase, environment: { ...validEnvironment, deviceType: bad } })),
  // environment is not an object at all
  fc.oneof(fc.string(), fc.integer(), fc.constant(null))
    .map((bad) => ({ ...validBase, environment: bad })),
);

/** Combined arbitrary for all invalid annotation payloads */
const arbInvalidAnnotation = fc.oneof(
  arbMissingRequiredFields,
  arbWrongTypeFields,
  arbInvalidTarget,
  arbInvalidEnvironment,
);

// --- Property test ---

describe('Property 8: Malformed annotation request validation', () => {
  it('AnnotationSchema rejects payloads with missing required fields, wrong types, or invalid target/environment sub-fields with descriptive errors', () => {
    fc.assert(
      fc.property(arbInvalidAnnotation, (payload) => {
        const result = AnnotationSchema.safeParse(payload);

        expect(result.success).toBe(false);
        if (!result.success) {
          // Must have at least one descriptive error issue
          expect(result.error.issues.length).toBeGreaterThan(0);
          // Each issue must have a non-empty message
          for (const issue of result.error.issues) {
            expect(typeof issue.message).toBe('string');
            expect(issue.message.length).toBeGreaterThan(0);
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
