// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { checkDesignViolations, type DesignToken } from './designSystemChecker';

function el(style: string): Element {
  const e = document.createElement('div');
  e.setAttribute('style', style);
  document.body.appendChild(e);
  return e;
}
afterEach(() => { document.body.innerHTML = ''; });

const tokens = (over: Partial<DesignToken> = {}): DesignToken => ({
  fontSizes: [12, 14, 16], lineHeights: [1.5], spacing: [0, 4, 8, 16], colors: [], borderRadii: [0, 4, 8], ...over,
});

describe('checkDesignViolations', () => {
  it('reports nothing for an element that uses only token values', () => {
    expect(checkDesignViolations(el('font-size:14px;padding:8px;margin:16px;border-radius:4px'), tokens())).toEqual([]);
  });

  it('flags an off-scale font size with the nearest token; error beyond 2px, warning within', () => {
    const far = checkDesignViolations(el('font-size:22px'), tokens());
    expect(far).toContainEqual({ property: 'font-size', actual: '22px', expected: '16px (nearest token)', severity: 'error' });
    const near = checkDesignViolations(el('font-size:15px'), tokens({ fontSizes: [14, 16] }));
    expect(near.find((v) => v.property === 'font-size')!.severity).toBe('warning');
  });

  it('flags off-grid spacing (kebab-cased property) but tolerates ±1px rounding', () => {
    const v = checkDesignViolations(el('font-size:16px;padding-top:11px;margin-left:9px'), tokens());
    expect(v).toContainEqual({ property: 'padding-top', actual: '11px', expected: '8px', severity: 'warning' });
    expect(v.find((x) => x.property === 'margin-left')).toBeUndefined();
  });

  it('flags off-scale border radius', () => {
    const v = checkDesignViolations(el('font-size:16px;border-radius:5px;'), tokens({ borderRadii: [0, 8] }));
    expect(v).toContainEqual({ property: 'border-radius', actual: '5px', expected: '8px', severity: 'warning' });
  });

  it('checks colours only when colour tokens are configured', () => {
    const e = el('font-size:16px;color:rgb(255, 0, 0);background-color:rgb(0, 128, 0)');
    expect(checkDesignViolations(e, tokens()).some((v) => v.property.includes('color'))).toBe(false);
    const v = checkDesignViolations(e, tokens({ colors: ['#112233'] }));
    expect(v.map((x) => x.property)).toEqual(expect.arrayContaining(['color', 'background-color']));
    expect(checkDesignViolations(e, tokens({ colors: ['#ff0000', '#008000'] })).some((x) => x.property.includes('color'))).toBe(false);
  });
});
