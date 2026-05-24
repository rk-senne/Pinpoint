import { describe, it, expect } from 'vitest';
import { serializeAnnotation, deserializeAnnotation } from './serialization.js';
import type { Annotation } from './types.js';

const validAnnotation: Annotation = {
  id: 'ann-1',
  projectId: 'proj-1',
  pageId: 'page-1',
  type: 'note',
  severity: 'major',
  status: 'active',
  body: 'This button is misaligned',
  authorId: 'user-1',
  createdAt: '2024-01-15T10:30:00.000Z',
  updatedAt: '2024-01-15T10:30:00.000Z',
  target: {
    cssSelector: 'main > button.submit',
    xpath: '/html/body/main/button[1]',
    pageX: 200,
    pageY: 400,
    tagName: 'BUTTON',
    textSnippet: 'Submit',
  },
  environment: {
    browserFamily: 'Chrome',
    browserVersion: '124.0.6367.91',
    osFamily: 'macOS',
    osVersion: '14.5',
    deviceType: 'desktop',
    userAgentRaw: 'Mozilla/5.0 ...',
  },
  pinNumber: 1,
};

describe('serializeAnnotation', () => {
  it('returns a valid JSON string', () => {
    const json = serializeAnnotation(validAnnotation);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('preserves all fields in the JSON output', () => {
    const json = serializeAnnotation(validAnnotation);
    const parsed = JSON.parse(json);
    expect(parsed).toEqual(validAnnotation);
  });

  it('includes optional fields when present', () => {
    const withOptionals: Annotation = {
      ...validAnnotation,
      pageUrl: 'https://example.com',
      environment: {
        ...validAnnotation.environment,
        viewportWidth: 1920,
        viewportHeight: 1080,
        devicePixelRatio: 2,
      },
      guidelineId: 'guide-1',
      assigneeId: 'user-2',
      dueDate: '2024-02-01T00:00:00.000Z',
    };
    const json = serializeAnnotation(withOptionals);
    const parsed = JSON.parse(json);
    expect(parsed.pageUrl).toBe('https://example.com');
    expect(parsed.environment).toEqual(withOptionals.environment);
    expect(parsed.guidelineId).toBe('guide-1');
    expect(parsed.assigneeId).toBe('user-2');
    expect(parsed.dueDate).toBe('2024-02-01T00:00:00.000Z');
  });
});

describe('deserializeAnnotation', () => {
  it('returns success for valid annotation JSON', () => {
    const json = JSON.stringify(validAnnotation);
    const result = deserializeAnnotation(json);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(validAnnotation);
    }
  });

  it('returns error for invalid JSON syntax', () => {
    const result = deserializeAnnotation('{not valid json');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain('Invalid JSON');
    }
  });

  it('returns error for empty string', () => {
    const result = deserializeAnnotation('');
    expect(result.success).toBe(false);
  });

  it('returns error when required fields are missing', () => {
    const partial = JSON.stringify({ id: 'ann-1', body: 'test' });
    const result = deserializeAnnotation(partial);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message.length).toBeGreaterThan(0);
    }
  });

  it('returns error for invalid enum values', () => {
    const invalid = { ...validAnnotation, severity: 'extreme' };
    const result = deserializeAnnotation(JSON.stringify(invalid));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain('severity');
    }
  });

  it('returns error for wrong field types', () => {
    const invalid = { ...validAnnotation, pinNumber: 'not-a-number' };
    const result = deserializeAnnotation(JSON.stringify(invalid));
    expect(result.success).toBe(false);
  });

  it('returns error when environment is missing', () => {
    const { environment: _omit, ...withoutEnvironment } = validAnnotation;
    const result = deserializeAnnotation(JSON.stringify(withoutEnvironment));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain('environment');
    }
  });

  it('round-trips a valid annotation', () => {
    const json = serializeAnnotation(validAnnotation);
    const result = deserializeAnnotation(json);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(validAnnotation);
    }
  });
});
