// Feature: pinpoint-app, Property 7: Malformed JSON graceful handling
// **Validates: Requirements 13.4**

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { deserializeAnnotation } from '../../serialization.js';

// --- Arbitraries ---

/** Arbitrary that produces strings which are NOT valid JSON */
const arbNonJsonString = fc.oneof(
  fc.string(),                                    // random strings (includes empty)
  fc.constant(''),                                // explicit empty string
  fc.constant('{'),                               // partial JSON
  fc.constant('{"id":'),                          // truncated JSON
  fc.constant('[1, 2,]'),                         // trailing comma
  fc.constant("{'key': 'value'}"),                // single quotes
  fc.string().map((s) => s + '<>&\0\n\t\\"'),  // strings with special chars appended
);

/** Arbitrary that produces valid JSON but NOT conforming to the Annotation schema */
const arbNonAnnotationJson = fc.oneof(
  // primitives
  fc.constant('null'),
  fc.constant('true'),
  fc.constant('false'),
  fc.integer().map((n) => JSON.stringify(n)),
  fc.string().map((s) => JSON.stringify(s)),
  // arrays
  fc.array(fc.anything()).map((a) => JSON.stringify(a)),
  // objects with wrong types for known fields
  fc.record({
    id: fc.oneof(fc.integer(), fc.boolean(), fc.constant(null)),
    type: fc.constant('invalid_type'),
    severity: fc.constant('unknown_severity'),
  }).map((o) => JSON.stringify(o)),
  // objects missing required fields
  fc.record({
    id: fc.uuid(),
    projectId: fc.uuid(),
    // missing all other required fields
  }).map((o) => JSON.stringify(o)),
  // object with invalid enum values (new Annotation shape: pageId + environment)
  fc.record({
    id: fc.uuid(),
    projectId: fc.uuid(),
    pageId: fc.uuid(),
    type: fc.constant('invalid'),
    severity: fc.constant('critical'),
    status: fc.constant('active'),
    body: fc.string(),
    authorId: fc.uuid(),
    createdAt: fc.constant('2024-01-01T00:00:00.000Z'),
    updatedAt: fc.constant('2024-01-01T00:00:00.000Z'),
    target: fc.record({
      cssSelector: fc.string(),
      xpath: fc.string(),
      pageX: fc.integer(),
      pageY: fc.integer(),
      tagName: fc.string(),
      textSnippet: fc.string(),
    }),
    environment: fc.record({
      browserFamily: fc.constant('Chrome'),
      browserVersion: fc.constant(null),
      osFamily: fc.constant('macOS'),
      osVersion: fc.constant(null),
      deviceType: fc.constant('desktop'),
      userAgentRaw: fc.string(),
    }),
    pinNumber: fc.integer(),
  }).map((o) => JSON.stringify(o)),
);

// --- Property tests ---

describe('Property 7: Malformed JSON graceful handling', () => {
  it('non-JSON strings return { success: false } with a descriptive error message and never throw', () => {
    fc.assert(
      fc.property(arbNonJsonString, (input) => {
        // Must not throw
        const result = deserializeAnnotation(input);

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(typeof result.error.message).toBe('string');
          expect(result.error.message.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('valid JSON not conforming to Annotation schema returns { success: false } with a descriptive error message', () => {
    fc.assert(
      fc.property(arbNonAnnotationJson, (jsonStr) => {
        // Must not throw
        const result = deserializeAnnotation(jsonStr);

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(typeof result.error.message).toBe('string');
          expect(result.error.message.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 100 },
    );
  });
});
