import { describe, expect, it } from 'vitest';
import { renderMarkupSvg, shapeToSvgString } from './markupRender';

describe('markupRender numeric attributes', () => {
  it('coerces non-numeric coordinates so they cannot break out of an attribute', () => {
    const evil = '1" onload="alert(1)';
    const svg = shapeToSvgString({ type: 'rect', x: evil, y: 2, width: 3, height: 4, color: '#f00', strokeWidth: evil } as never);
    expect(svg).not.toContain('onload');
    expect(svg).toContain('x="0"');
    expect(svg).toContain('stroke-width="0"');
  });

  it('coerces freehand points the same way', () => {
    const svg = shapeToSvgString({ type: 'stroke', points: [{ x: '1"><script>', y: 2 }, { x: 3, y: 4 }], color: '#000', strokeWidth: 2 } as never);
    expect(svg).not.toContain('<script');
    expect(svg).toContain('M 0 2 L 3 4');
  });

  it('keeps real numbers intact', () => {
    const svg = renderMarkupSvg({ shapes: [{ type: 'arrow', x1: 1.5, y1: 2, x2: 30, y2: 40, color: '#00f', strokeWidth: 3 }] } as never, 100, 50);
    expect(svg).toContain('x1="1.5"');
    expect(svg).toContain('stroke-width="3"');
  });
});
