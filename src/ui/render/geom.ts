/** 2D geometry helpers for drawing (Vec points, curves, rotations). */

export interface Vec {
  x: number;
  y: number;
}

export const v = (x: number, y: number): Vec => ({ x, y });
export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec, s: number): Vec => ({ x: a.x * s, y: a.y * s });
export const len = (a: Vec): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);
export const norm = (a: Vec): Vec => {
  const l = Math.hypot(a.x, a.y) || 1;
  return { x: a.x / l, y: a.y / l };
};
export const polar = (c: Vec, r: number, ang: number): Vec => ({ x: c.x + r * Math.cos(ang), y: c.y + r * Math.sin(ang) });
export const rotateAbout = (p: Vec, c: Vec, ang: number): Vec => {
  const s = Math.sin(ang), co = Math.cos(ang);
  const dx = p.x - c.x, dy = p.y - c.y;
  return { x: c.x + dx * co - dy * s, y: c.y + dx * s + dy * co };
};

/** Polyline stored as flat arrays for fast intersection. */
export class Polyline {
  xs: number[] = [];
  ys: number[] = [];
  push(p: Vec): this {
    this.xs.push(p.x);
    this.ys.push(p.y);
    return this;
  }
  pushXY(x: number, y: number): this {
    this.xs.push(x);
    this.ys.push(y);
    return this;
  }
  append(pts: Vec[], skipFirst = false): this {
    for (let i = skipFirst ? 1 : 0; i < pts.length; i++) this.push(pts[i]);
    return this;
  }
  get length(): number {
    return this.xs.length;
  }
  point(i: number): Vec {
    return { x: this.xs[i], y: this.ys[i] };
  }
  toArray(): Vec[] {
    return this.xs.map((x, i) => ({ x, y: this.ys[i] }));
  }
  clear(): void {
    this.xs.length = 0;
    this.ys.length = 0;
  }
}

/** Sample a cubic Bézier into `count` points (including both ends). */
export function bezier3(p0: Vec, p1: Vec, p2: Vec, p3: Vec, count: number): Vec[] {
  const pts: Vec[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    pts.push({ x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y });
  }
  return pts;
}

/** Sample a quadratic Bézier. */
export function bezier2(p0: Vec, p1: Vec, p2: Vec, count: number): Vec[] {
  const pts: Vec[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const u = 1 - t;
    pts.push({ x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x, y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y });
  }
  return pts;
}

/** Arc from angle a0 to a1 (radians, either direction), `count` points. */
export function arc(c: Vec, r: number, a0: number, a1: number, count: number): Vec[] {
  const pts: Vec[] = [];
  for (let i = 0; i < count; i++) pts.push(polar(c, r, a0 + ((a1 - a0) * i) / (count - 1)));
  return pts;
}

/** Catmull–Rom spline through points (centripetal-ish uniform), `per` samples per segment. */
export function catmullRom(pts: Vec[], per: number): Vec[] {
  if (pts.length < 3) return pts.slice();
  const out: Vec[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let k = 0; k < per; k++) {
      const t = k / per;
      const t2 = t * t, t3 = t2 * t;
      out.push({
        x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}
