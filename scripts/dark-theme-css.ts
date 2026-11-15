// Build-time dark theme for the app stylesheets (decision 018).
//
// The stylesheets hold several hundred literal colours across the app, and other work edits those
// files every day. Instead of hand-copying each rule into a dark twin, this PostCSS plugin reads every
// colour declaration while Vite bundles the CSS and emits a sibling rule, scoped to
// `:root[data-theme='dark']` and to screens only, with the colour remapped by its role:
//   - surfaces (background) that are light become dark navy surfaces, accents keep their fill;
//   - text, icons and accents (color/fill/stroke and accent variables) that are dark become light;
//   - borders become low-contrast dark lines; shadows become black.
// The mapping keeps each colour's hue in OKLCH, so the Sabq blue, status greens/ambers/reds and the
// logo keep their identity. The source CSS files are untouched (the server reads them raw for PDFs),
// print output never sees the dark rules (`@media screen`), and the paper previews of quotes,
// invoices, statements, payslips, registers, letters and the employee report stay light.
// Hand-tuned exceptions live in src/theme/dark.css.

type Role = 'surface' | 'text' | 'border' | 'shadow';

/** Paper previews: printed documents keep their light look on screen too. */
export const LIGHT_ISLANDS = [
  '.fin-document-paper',
  '.payroll-print-sheet',
  '.employee-report',
  '.issued-letter',
];
const DARK = ":root[data-theme='dark']";
const ISLAND_NOT = `:not(:is(${LIGHT_ISLANDS.join(', ')}) *)`;

// ---- colour maths (sRGB <-> OKLab) -------------------------------------------------------------
type Rgba = [number, number, number, number];
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function rgbToOklch([r, g, b]: Rgba): [number, number, number] {
  const [lr, lg, lb] = [r, g, b].map((v) => toLinear(v / 255));
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), Math.atan2(B, A)];
}

function oklchToRgb(L: number, C: number, h: number): [number, number, number] | null {
  const A = C * Math.cos(h);
  const B = C * Math.sin(h);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  if (rgb.some((v) => v < -0.0005 || v > 1.0005)) return null;
  return rgb.map((v) => Math.round(toGamma(Math.min(1, Math.max(0, v))) * 255)) as [
    number,
    number,
    number,
  ];
}

/** Brings an OKLCH colour into sRGB by lowering its chroma, keeping lightness and hue. */
function inGamut(L: number, C: number, h: number): [number, number, number] {
  for (let c = C; c > 0; c -= 0.004) {
    const rgb = oklchToRgb(L, c, h);
    if (rgb) return rgb;
  }
  return oklchToRgb(L, 0, h) ?? [0, 0, 0];
}

const NAVY_HUE = 4.4; // radians, the hue of the Sabq ink (#142d48)

function remap(rgba: Rgba, role: Role): Rgba {
  const alpha = rgba[3];
  if (role === 'shadow') return [0, 0, 0, Math.min(0.6, alpha * 2.2)];
  let [L, C, h] = rgbToOklch(rgba);
  const neutral = C < 0.03;
  if (C < 0.008) h = NAVY_HUE;
  if (role === 'surface') {
    if (L >= 0.86 && C >= 0.008 && L < 0.995) {
      // Pale tints (hover, selected, highlight, chips) rise above the card, keeping their hue.
      L = 0.3 + (1 - L) * 0.3;
      C = Math.min(Math.max(C * 1.5, 0.025), 0.06);
    } else if (L >= 0.86) {
      // White card -> 0.245; grey page/soft fills sit a little lower.
      L = 0.245 - (1 - L) * 0.75;
      C = 0.022;
    } else if (L >= 0.7) {
      // Pale badges and selection fills.
      L = 0.36 - (0.86 - L) * 0.3;
      C = Math.min(C, 0.08);
    } else if (neutral && L < 0.4) {
      L = Math.max(L, 0.3); // dark chips (tooltips) stay dark but separate from the page
    }
    // Saturated mid/dark fills (primary buttons, status dots) keep their colour and white text.
  } else if (role === 'text') {
    if (L < 0.72) {
      L = 1.07 - L * 0.55;
      C = neutral ? 0.02 : Math.min(C, 0.13);
    }
  } else if (role === 'border') {
    if (L >= 0.7) {
      L = 0.33 + (1 - L) * 0.35;
      C = neutral ? 0.025 : Math.min(C, 0.06);
    } else if (L < 0.45) {
      L = 1.0 - L; // dark rules (rare) become light
    }
  }
  const [r, g, b] = inGamut(Math.min(0.985, Math.max(0.1, L)), C, h);
  return [r, g, b, alpha];
}

// ---- parsing ------------------------------------------------------------------------------------
const COLOUR =
  /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b|rgba?\([^)]*\)|\b(?:white|black)\b(?![-\w])/gi;

function parse(token: string): Rgba | null {
  const t = token.toLowerCase();
  if (t === 'white') return [255, 255, 255, 1];
  if (t === 'black') return [0, 0, 0, 1];
  if (t.startsWith('#')) {
    let hex = t.slice(1);
    if (hex.length <= 4) hex = [...hex].map((c) => c + c).join('');
    const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), hex.length === 8 ? n(6) / 255 : 1];
  }
  const parts = t
    .replace(/rgba?\(|\)/g, '')
    .split(/[\s,/]+/)
    .filter(Boolean);
  if (parts.length < 3) return null;
  const channel = (p: string) => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p));
  const alpha = parts[3] ? (parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : +parts[3]) : 1;
  return [channel(parts[0]), channel(parts[1]), channel(parts[2]), alpha];
}

function format([r, g, b, a]: Rgba): string {
  const hex = '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  return a >= 1
    ? hex
    : `rgb(${Math.round(r)} ${Math.round(g)} ${Math.round(b)} / ${+a.toFixed(3)})`;
}

/**
 * Accent variables (--blue, --payroll-blue, ...) are remapped as text, so they read on dark
 * surfaces. Where one fills a background or border, the twin uses the variable's light literal
 * remapped for that role instead, which keeps primary buttons the brand blue with white text.
 */
const accentVariables = new Map<string, string>();
export function registerVariables(css: string) {
  for (const [, name, value] of css.matchAll(/(--[\w-]+)\s*:\s*([^;}{]+)/g)) {
    if (roleOf(name) === 'text' && new RegExp(COLOUR.source, 'i').test(value))
      accentVariables.set(name, value.trim());
  }
}

export function darkValue(value: string, role: Role): string {
  if (role !== 'text')
    value = value.replace(/var\((--[\w-]+)\s*(?:,[^)]*)?\)/g, (whole, name: string) =>
      accentVariables.has(name) ? accentVariables.get(name)! : whole,
    );
  return value.replace(COLOUR, (token) => {
    const rgba = parse(token);
    return rgba ? format(remap(rgba, role)) : token;
  });
}

function roleOf(prop: string): Role | null {
  const p = prop.toLowerCase();
  if (p.startsWith('--')) {
    if (/line|border|rule/.test(p)) return 'border';
    if (/shadow/.test(p)) return 'shadow';
    if (/bg|surface|soft|paper|fill|wash|tint/.test(p)) return 'surface';
    return 'text'; // ink, muted, blue and status accents are read as text
  }
  if (p === 'background' || p === 'background-color' || p === 'background-image') return 'surface';
  if (p === 'box-shadow' || p === 'text-shadow' || p === 'filter') return 'shadow';
  if (/radius|width|style|collapse|spacing|offset|image/.test(p)) return null;
  if (p.startsWith('border') || p.startsWith('outline') || p === 'column-rule-color')
    return 'border';
  if (
    [
      'color',
      'fill',
      'stroke',
      'caret-color',
      'text-decoration-color',
      'accent-color',
      'text-decoration',
    ].includes(p)
  )
    return 'text';
  return null;
}

// ---- selectors ----------------------------------------------------------------------------------
function scopeSelector(selector: string): string {
  const trimmed = selector.trim();
  if (/^(:root|html)$/.test(trimmed)) return DARK;
  if (/^body\b/.test(trimmed)) return `${DARK} ${trimmed}`;
  if (/^(:root|html)\b/.test(trimmed)) return trimmed.replace(/^(:root|html)/, DARK);
  if (LIGHT_ISLANDS.some((island) => trimmed.includes(island))) return '';
  // Put the island exclusion on the last compound, before any pseudo-element.
  const pseudo = trimmed.match(/::?(?:before|after|placeholder|selection|marker|backdrop)\b.*$/);
  const head = pseudo ? trimmed.slice(0, pseudo.index) : trimmed;
  const tail = pseudo ? pseudo[0] : '';
  return `${DARK} ${head}${ISLAND_NOT}${tail}`;
}

function splitSelectors(selector: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of selector) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
    } else current += ch;
  }
  out.push(current);
  return out.map((s) => s.trim()).filter(Boolean);
}

// ---- the PostCSS plugin (typed loosely so the config needs no extra type packages) --------------
/* eslint-disable @typescript-eslint/no-explicit-any */
export function darkThemePlugin(sources: string[] = []): any {
  for (const css of sources) registerVariables(css);
  return {
    postcssPlugin: 'sabq-dark-theme',
    OnceExit(root: any, { AtRule }: any) {
      const skipped = (node: any): boolean => {
        for (let p = node.parent; p && p.type !== 'root'; p = p.parent) {
          if (p.type === 'atrule' && /keyframes|font-face/i.test(p.name)) return true;
          if (p.type === 'atrule' && p.name === 'media' && /\bprint\b/.test(p.params)) return true;
        }
        return false;
      };
      // Wrapped in `@media screen` so printing (and print-to-PDF) always uses the light rules.
      const screen = (node: any) => new AtRule({ name: 'media', params: 'screen' }).append(node);
      const additions: Array<[any, any]> = [];
      const islandVars: any[] = [];
      root.walkRules((rule: any) => {
        if (skipped(rule) || rule.selector.includes(DARK)) return;
        const decls: any[] = [];
        rule.each((node: any) => {
          if (node.type !== 'decl') return;
          const role = roleOf(node.prop);
          if (!role) return;
          const value = darkValue(node.value, role);
          // Every colour declaration gets a twin, even when its value is kept (a green "on"
          // track, `transparent`, `none`): the twins are more specific than the source rules, so a
          // skipped state rule would lose to the twin of its base rule.
          decls.push(node.clone({ value }));
          if (node.prop.startsWith('--')) islandVars.push(node.clone());
        });
        if (!decls.length) return;
        const selector = splitSelectors(rule.selector)
          .map(scopeSelector)
          .filter(Boolean)
          .join(', ');
        if (!selector) return;
        const twin = rule.clone({ selector, nodes: [] });
        decls.forEach((d) => twin.append(d));
        additions.push([rule, twin]);
      });
      for (const [rule, twin] of additions) rule.after(screen(twin));
      if (islandVars.length) {
        // Variables inherited into a paper preview keep their light values.
        const reset = additions[0][1].clone({
          selector: `${DARK} :is(${LIGHT_ISLANDS.join(', ')})`,
          nodes: [],
        });
        islandVars.forEach((d) => reset.append(d));
        root.append(screen(reset));
      }
    },
  };
}
darkThemePlugin.postcss = true;
