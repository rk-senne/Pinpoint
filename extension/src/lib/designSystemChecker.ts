/**
 * DesignSystemChecker — scans an annotated element against a design
 * token configuration and surfaces violations (spacing, colors, typography).
 *
 * The design tokens are loaded from the project's configuration (stored
 * server-side and synced to extension via the Syncer).
 */

export interface DesignToken {
  fontSizes: number[];
  lineHeights: number[];
  spacing: number[];   // multiples of base (e.g., 4px grid: [4, 8, 12, 16, 20, 24, 32])
  colors: string[];    // hex values
  borderRadii: number[];
}

export interface Violation {
  property: string;
  actual: string;
  expected: string;
  severity: 'error' | 'warning';
}

const DEFAULT_TOKENS: DesignToken = {
  fontSizes: [12, 14, 16, 18, 20, 24, 30, 36, 48],
  lineHeights: [1, 1.25, 1.375, 1.5, 1.625, 2],
  spacing: [0, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64],
  colors: [],
  borderRadii: [0, 2, 4, 6, 8, 12, 16, 9999],
};

export function checkDesignViolations(element: Element, tokens: DesignToken = DEFAULT_TOKENS): Violation[] {
  const violations: Violation[] = [];
  const style = getComputedStyle(element);

  // Font size check
  const fontSize = parseFloat(style.fontSize);
  if (tokens.fontSizes.length && !tokens.fontSizes.includes(fontSize)) {
    const closest = tokens.fontSizes.reduce((a, b) => Math.abs(b - fontSize) < Math.abs(a - fontSize) ? b : a);
    violations.push({
      property: 'font-size',
      actual: `${fontSize}px`,
      expected: `${closest}px (nearest token)`,
      severity: Math.abs(fontSize - closest) > 2 ? 'error' : 'warning',
    });
  }

  // Spacing check (padding + margin)
  for (const prop of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft'] as const) {
    const val = parseFloat(style[prop]);
    if (val > 0 && tokens.spacing.length && !tokens.spacing.includes(val)) {
      const closest = tokens.spacing.reduce((a, b) => Math.abs(b - val) < Math.abs(a - val) ? b : a);
      if (Math.abs(val - closest) > 1) {
        violations.push({
          property: prop.replace(/([A-Z])/g, '-$1').toLowerCase(),
          actual: `${val}px`,
          expected: `${closest}px`,
          severity: 'warning',
        });
      }
    }
  }

  // Border radius check
  const borderRadius = parseFloat(style.borderRadius);
  if (borderRadius > 0 && tokens.borderRadii.length && !tokens.borderRadii.includes(borderRadius)) {
    const closest = tokens.borderRadii.reduce((a, b) => Math.abs(b - borderRadius) < Math.abs(a - borderRadius) ? b : a);
    violations.push({
      property: 'border-radius',
      actual: `${borderRadius}px`,
      expected: `${closest}px`,
      severity: 'warning',
    });
  }

  // Color check
  if (tokens.colors.length) {
    const color = rgbToHex(style.color);
    const bgColor = rgbToHex(style.backgroundColor);
    if (color && !tokens.colors.includes(color)) {
      violations.push({ property: 'color', actual: color, expected: 'Not in design tokens', severity: 'warning' });
    }
    if (bgColor && bgColor !== '#000000' && bgColor !== '#ffffff' && !tokens.colors.includes(bgColor)) {
      violations.push({ property: 'background-color', actual: bgColor, expected: 'Not in design tokens', severity: 'warning' });
    }
  }

  return violations;
}

function rgbToHex(rgb: string): string | null {
  const match = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) return null;
  return '#' + [match[1], match[2], match[3]].map((n) => parseInt(n!).toString(16).padStart(2, '0')).join('');
}
