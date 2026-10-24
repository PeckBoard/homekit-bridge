// HomeKit hue/saturation <-> Hue CIE 1931 xy, gamut-clamped. Matrices are the
// "Wide RGB D65" conversion from Philips' Hue developer docs (RGB to xy
// colour conversion); hue/sat is taken at full value (xy carries no
// brightness).

export interface XY {
  x: number;
  y: number;
}

export interface Gamut {
  red: XY;
  green: XY;
  blue: XY;
}

/** The Hue gamut letters (`color.gamut_type`) for lights that don't report
 * the triangle itself. */
export const GAMUTS: Record<string, Gamut> = {
  A: { red: { x: 0.704, y: 0.296 }, green: { x: 0.2151, y: 0.7106 }, blue: { x: 0.138, y: 0.08 } },
  B: { red: { x: 0.675, y: 0.322 }, green: { x: 0.409, y: 0.518 }, blue: { x: 0.167, y: 0.04 } },
  C: { red: { x: 0.6915, y: 0.3083 }, green: { x: 0.17, y: 0.7 }, blue: { x: 0.1532, y: 0.0475 } },
};

const cross = (a: XY, b: XY) => a.x * b.y - a.y * b.x;
const sub = (a: XY, b: XY): XY => ({ x: a.x - b.x, y: a.y - b.y });

function inGamut(p: XY, g: Gamut): boolean {
  const v1 = sub(g.green, g.red);
  const v2 = sub(g.blue, g.red);
  const q = sub(p, g.red);
  const d = cross(v1, v2);
  const s = cross(q, v2) / d;
  const t = cross(v1, q) / d;
  return s >= 0 && t >= 0 && s + t <= 1;
}

function closestOnSegment(p: XY, a: XY, b: XY): XY {
  const ab = sub(b, a);
  const len = ab.x * ab.x + ab.y * ab.y;
  const t = len ? Math.min(1, Math.max(0, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / len)) : 0;
  return { x: a.x + ab.x * t, y: a.y + ab.y * t };
}

/** `p` itself when inside the gamut triangle, else the closest point on its
 * edge. */
export function clampToGamut(p: XY, g: Gamut | null | undefined): XY {
  if (!g || inGamut(p, g)) return p;
  const cands = [
    closestOnSegment(p, g.red, g.green),
    closestOnSegment(p, g.green, g.blue),
    closestOnSegment(p, g.blue, g.red),
  ];
  const dist = (c: XY) => (c.x - p.x) ** 2 + (c.y - p.y) ** 2;
  return cands.reduce((best, c) => (dist(c) < dist(best) ? c : best));
}

const expand = (v: number) => (v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92);
const compress = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** hue 0–360, saturation 0–100 → xy inside `gamut`. */
export function hsToXy(hue: number, sat: number, gamut?: Gamut | null): XY {
  const h = (((hue % 360) + 360) % 360) / 60;
  const s = Math.min(1, Math.max(0, sat / 100));
  const c = s;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const [r1, g1, b1] =
    h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  const m = 1 - c;
  const [r, g, b] = [r1 + m, g1 + m, b1 + m].map(expand);
  const X = r * 0.664511 + g * 0.154324 + b * 0.162028;
  const Y = r * 0.283881 + g * 0.668433 + b * 0.047685;
  const Z = r * 0.000088 + g * 0.07231 + b * 0.986039;
  const sum = X + Y + Z;
  const p = clampToGamut({ x: X / sum, y: Y / sum }, gamut);
  return { x: round4(p.x), y: round4(p.y) };
}

/** xy → { hue 0–360, sat 0–100 }, both rounded to 0.1. */
export function xyToHs(p: XY): { hue: number; sat: number } {
  const y = Math.max(p.y, 1e-6);
  const Y = 1;
  const X = (p.x / y) * Y;
  const Z = ((1 - p.x - p.y) / y) * Y;
  let rgb = [
    X * 1.656492 - Y * 0.354851 - Z * 0.255038,
    -X * 0.707196 + Y * 1.655397 + Z * 0.036152,
    X * 0.051713 - Y * 0.121364 + Z * 1.01153,
  ].map((v) => Math.max(0, v));
  const max = Math.max(...rgb);
  if (max > 0) rgb = rgb.map((v) => v / max);
  const [r, g, b] = rgb.map(compress).map((v) => Math.min(1, Math.max(0, v)));
  const hi = Math.max(r, g, b);
  const lo = Math.min(r, g, b);
  const d = hi - lo;
  let h = 0;
  if (d > 0) {
    if (hi === r) h = 60 * (((g - b) / d) % 6);
    else if (hi === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  const sat = hi > 0 ? (d / hi) * 100 : 0;
  const r1 = (n: number) => Math.round(n * 10) / 10;
  return { hue: r1(h) % 360, sat: r1(sat) };
}
