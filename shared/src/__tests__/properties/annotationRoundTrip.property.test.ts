// Feature: pinpoint-app, Property 6: Annotation serialization round-trip
// **Validates: Requirements 13.1, 13.2, 13.3**

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { serializeAnnotation, deserializeAnnotation } from '../../serialization.js';
import type { Annotation, EnvironmentMetadata } from '../../types.js';

// --- Arbitraries ---

const arbAnnotationType = fc.constantFrom('note', 'suggestion', 'guideline') as fc.Arbitrary<Annotation['type']>;
const arbSeverity = fc.constantFrom('critical', 'major', 'minor', 'informational') as fc.Arbitrary<Annotation['severity']>;
const arbAnnotationStatus = fc.constantFrom('active', 'in_progress', 'resolved') as fc.Arbitrary<Annotation['status']>;

const arbBrowserFamily = fc.constantFrom(
  'Chrome', 'Edge', 'Safari', 'Firefox', 'Opera', 'Brave', 'Arc', 'Other', 'unknown',
) as fc.Arbitrary<EnvironmentMetadata['browserFamily']>;
const arbOsFamily = fc.constantFrom(
  'macOS', 'Windows', 'Linux', 'iOS', 'Android', 'ChromeOS', 'Other', 'unknown',
) as fc.Arbitrary<EnvironmentMetadata['osFamily']>;
const arbDeviceType = fc.constantFrom('desktop', 'tablet', 'mobile') as fc.Arbitrary<EnvironmentMetadata['deviceType']>;

const arbIso8601 = fc.integer({
  min: new Date('2000-01-01T00:00:00.000Z').getTime(),
  max: new Date('2099-12-31T23:59:59.999Z').getTime(),
}).map((ts) => new Date(ts).toISOString());

const arbDOMTarget = fc.record({
  cssSelector: fc.string({ minLength: 1 }),
  xpath: fc.string({ minLength: 1 }),
  pageX: fc.double({ min: 0, max: 10000, noNaN: true, noDefaultInfinity: true }),
  pageY: fc.double({ min: 0, max: 10000, noNaN: true, noDefaultInfinity: true }),
  tagName: fc.string({ minLength: 1 }),
  textSnippet: fc.string({ maxLength: 100 }),
});

// EnvironmentMetadata is required on every Annotation (Req 17.3). The
// viewport / pixel-ratio fields stay optional for back-compat with the legacy
// bug-report payload — using fc.option(..., { nil: undefined }) keeps keys
// that are dropped by JSON.stringify(undefined) and re-emerge as absent on
// deserialize, which `toEqual` treats as equivalent.
const arbEnvironmentMetadata: fc.Arbitrary<EnvironmentMetadata> = fc.record({
  browserFamily: arbBrowserFamily,
  browserVersion: fc.option(fc.string({ minLength: 1 }), { nil: null }),
  osFamily: arbOsFamily,
  osVersion: fc.option(fc.string({ minLength: 1 }), { nil: null }),
  deviceType: arbDeviceType,
  userAgentRaw: fc.string(),
  viewportWidth: fc.option(
    fc.double({ min: 1, max: 10000, noNaN: true, noDefaultInfinity: true }),
    { nil: undefined },
  ),
  viewportHeight: fc.option(
    fc.double({ min: 1, max: 10000, noNaN: true, noDefaultInfinity: true }),
    { nil: undefined },
  ),
  devicePixelRatio: fc.option(
    fc.double({ min: 0.5, max: 5, noNaN: true, noDefaultInfinity: true }),
    { nil: undefined },
  ),
}) as fc.Arbitrary<EnvironmentMetadata>;

const arbAnnotation: fc.Arbitrary<Annotation> = fc.record({
  id: fc.uuid(),
  projectId: fc.uuid(),
  pageId: fc.uuid(),
  // pageUrl is the optional derived field surfaced for client convenience.
  pageUrl: fc.option(fc.webUrl(), { nil: undefined }),
  type: arbAnnotationType,
  severity: arbSeverity,
  status: arbAnnotationStatus,
  body: fc.string(),
  authorId: fc.uuid(),
  createdAt: arbIso8601,
  updatedAt: arbIso8601,
  target: arbDOMTarget,
  environment: arbEnvironmentMetadata,
  guidelineId: fc.option(fc.uuid(), { nil: undefined }),
  assigneeId: fc.option(fc.uuid(), { nil: undefined }),
  dueDate: fc.option(arbIso8601, { nil: undefined }),
  pinNumber: fc.integer({ min: 0, max: 100000 }),
}) as fc.Arbitrary<Annotation>;

// --- Property test ---

describe('Property 6: Annotation serialization round-trip', () => {
  it('serializing then deserializing any valid Annotation produces a deeply equal object', () => {
    fc.assert(
      fc.property(arbAnnotation, (annotation) => {
        const json = serializeAnnotation(annotation);
        const result = deserializeAnnotation(json);

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toEqual(annotation);
        }
      }),
      { numRuns: 100 },
    );
  });
});
