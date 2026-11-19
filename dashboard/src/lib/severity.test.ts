import { describe, expect, it } from 'vitest';
import { severityTextColor } from './severity';

describe('severityTextColor', () => {
  it('maps each severity to its themed text token', () => {
    expect(severityTextColor('critical')).toBe('var(--pp-severity-critical-text)');
    expect(severityTextColor('major')).toBe('var(--pp-severity-major-text)');
    expect(severityTextColor('minor')).toBe('var(--pp-severity-minor-text)');
    expect(severityTextColor('informational')).toBe('var(--pp-severity-info-text)');
  });
  it('falls back to primary text for unknown values', () => {
    expect(severityTextColor('bogus')).toBe('var(--pp-text-primary)');
    expect(severityTextColor(undefined)).toBe('var(--pp-text-primary)');
  });
});
