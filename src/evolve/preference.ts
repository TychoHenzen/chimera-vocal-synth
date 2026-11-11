/**
 * The listener's taste, learned from A/B answers (Evolve's "learn from my ear" mode). Every voice
 * is described by its render's ear features (`chimera::analysis::ear`); a Bradley-Terry model
 * gives each voice a reward r = w . z (z: the features standardised over the voices heard and
 * searched), with P(A preferred to B) = sigmoid(r_A - r_B). A bootstrap ensemble of fits says how
 * sure the model is, so the search can stay where the listener's answers reach and the questions
 * can go where the fits disagree.
 *
 * Pure functions, no engine: tests/ear-preference.test.ts runs them on made-up listeners.
 */

/** One answer: the features of the voice played as A and as B, and y = 1 (A), 0 (B) or 0.5 (same). */
export interface Pair {
  a: number[];
  b: number[];
  y: number;
}

export interface Standard {
  mean: number[];
  std: number[];
}

export interface Model {
  standard: Standard;
  /** the fit on every answer */
  w: number[];
  /** fits on bootstrap resamples of the answers */
  ensemble: number[][];
}

// ASSUMPTION: an L2 weight of 1 (standardised features, about 19 of them) keeps a fit on 5-30
// answers from swinging on one answer; untuned.
export const L2 = 1;
// ASSUMPTION: 12 bootstrap fits are enough to rank where the fits disagree; untuned.
export const ENSEMBLE = 12;

const sigmoid = (s: number) => 1 / (1 + Math.exp(-s));
const dot = (a: number[], b: number[]) => a.reduce((t, v, i) => t + v * b[i], 0);

/** Mean and spread of each feature over `rows`; a feature that never varies gets spread 1. */
export function standardOf(rows: number[][]): Standard {
  const d = rows[0]?.length ?? 0;
  const mean = new Array<number>(d).fill(0);
  const std = new Array<number>(d).fill(0);
  for (const r of rows) r.forEach((v, i) => (mean[i] += v / rows.length));
  for (const r of rows) r.forEach((v, i) => (std[i] += (v - mean[i]) ** 2 / rows.length));
  return { mean, std: std.map((v) => (v > 1e-12 ? Math.sqrt(v) : 1)) };
}

export function standardise(s: Standard, f: number[]): number[] {
  return f.map((v, i) => (v - s.mean[i]) / s.std[i]);
}

/** Solve `m x = v` (m symmetric positive definite) by Gaussian elimination with pivoting. */
function solve(m: number[][], v: number[]): number[] {
  const n = v.length;
  const a = m.map((row, i) => [...row, v[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    [a[c], a[p]] = [a[p], a[c]];
    for (let r = c + 1; r < n; r++) {
      const k = a[r][c] / a[c][c];
      for (let j = c; j <= n; j++) a[r][j] -= k * a[c][j];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let t = a[r][n];
    for (let j = r + 1; j < n; j++) t -= a[r][j] * x[j];
    x[r] = t / a[r][r];
  }
  return x;
}

/**
 * L2-regularised Bradley-Terry weights for differences `dz` (A minus B, standardised) with
 * labels `y`, each answer counted `count[i]` times (bootstrap); Newton's method, which converges
 * in a handful of steps since the loss is convex.
 */
export function fitWeights(dz: number[][], y: number[], l2 = L2, count?: number[]): number[] {
  const d = dz[0]?.length ?? 0;
  let w = new Array<number>(d).fill(0);
  for (let it = 0; it < 25; it++) {
    const grad = w.map((v) => l2 * v);
    const hess = Array.from({ length: d }, (_, i) => Array.from({ length: d }, (_, j) => (i === j ? l2 : 0)));
    dz.forEach((x, k) => {
      const c = count ? count[k] : 1;
      if (!c) return;
      const p = sigmoid(dot(w, x));
      const g = c * (p - y[k]);
      const h = c * p * (1 - p);
      for (let i = 0; i < d; i++) {
        grad[i] += g * x[i];
        for (let j = 0; j < d; j++) hess[i][j] += h * x[i] * x[j];
      }
    });
    const step = solve(hess, grad);
    w = w.map((v, i) => v - step[i]);
    if (Math.max(...step.map(Math.abs)) < 1e-6) break;
  }
  return w;
}

/** A small seeded generator (mulberry32). */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fit the model to `pairs`, standardising over `pool` (the features of every voice in play). */
export function fit(pairs: Pair[], pool: number[][], seed = 1, l2 = L2): Model {
  const standard = standardOf(pool.length ? pool : pairs.flatMap((p) => [p.a, p.b]));
  const dz = pairs.map((p) => standardise(standard, p.a).map((v, i) => v - standardise(standard, p.b)[i]));
  const y = pairs.map((p) => p.y);
  const w = fitWeights(dz, y, l2);
  const r = rng(seed);
  const ensemble = Array.from({ length: ENSEMBLE }, () => {
    const count = new Array<number>(pairs.length).fill(0);
    for (let k = 0; k < pairs.length; k++) count[Math.floor(r() * pairs.length)]++;
    return fitWeights(dz, y, l2, count);
  });
  return { standard, w, ensemble };
}

/** The reward of a voice by the full fit, and its mean and spread over the ensemble. */
export function reward(m: Model, f: number[]): { r: number; mean: number; spread: number } {
  const z = standardise(m.standard, f);
  const rs = m.ensemble.map((w) => dot(w, z));
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
  const spread = Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / rs.length);
  return { r: dot(m.w, z), mean, spread };
}

/** How sure the ensemble is that `a` beats `b`: mean and spread of r_a - r_b over its fits. */
export function edge(m: Model, a: number[], b: number[]): { mean: number; spread: number } {
  const za = standardise(m.standard, a);
  const zb = standardise(m.standard, b);
  const ds = m.ensemble.map((w) => dot(w, za) - dot(w, zb));
  const mean = ds.reduce((x, y) => x + y, 0) / ds.length;
  return { mean, spread: Math.sqrt(ds.reduce((x, y) => x + (y - mean) ** 2, 0) / ds.length) };
}

/**
 * Leave-one-out agreement: how many decisive answers (not "same") a fit on all the others
 * predicts. The honest measure of whether the model has learned anything yet.
 */
export function agreement(pairs: Pair[], pool: number[][], l2 = L2): { right: number; of: number } {
  const standard = standardOf(pool.length ? pool : pairs.flatMap((p) => [p.a, p.b]));
  const dz = pairs.map((p) => standardise(standard, p.a).map((v, i) => v - standardise(standard, p.b)[i]));
  let right = 0;
  let of = 0;
  pairs.forEach((p, k) => {
    if (p.y === 0.5) return;
    of++;
    const count = pairs.map((_, j) => (j === k ? 0 : 1));
    const w = fitWeights(dz, pairs.map((q) => q.y), l2, count);
    if (dot(w, dz[k]) > 0 === p.y > 0.5) right++;
  });
  return { right, of };
}

/** Distance (standardised features) from `f` to the nearest of `heard`. */
export function nearest(m: Model, f: number[], heard: number[][]): number {
  const z = standardise(m.standard, f);
  let best = Infinity;
  for (const h of heard) {
    const zh = standardise(m.standard, h);
    best = Math.min(best, Math.sqrt(z.reduce((t, v, i) => t + (v - zh[i]) ** 2, 0)));
  }
  return best;
}

/**
 * The typical distance between a heard voice and the nearest other heard voice: how far the
 * listener's answers reach around each voice they have heard.
 */
export function reach(m: Model, heard: number[][]): number {
  if (heard.length < 2) return 0.5;
  const d = heard.map((h, i) => nearest(m, h, heard.filter((_, j) => j !== i))).sort((a, b) => a - b);
  return d[d.length >> 1];
}

export interface SearchWeights {
  /** how many ensemble spreads below its mean a voice's reward is taken to be */
  caution: number;
  /**
   * how far (standardised) beyond the listener's reach the search may go: the penalty for going
   * further grows with the reward's own slope, so a surer model does not run further out
   */
  beyond: number;
  /** reward lost per squared unit of genome distance (genes 0..1) from the default voice */
  pull: number;
}
// ASSUMPTION: one spread of caution, a quarter of a standard deviation beyond reach, and 1 logit
// per unit of squared genome distance (moving all 38 searched genes by 0.1 costs 0.38) are first
// guesses; the page exposes them.
export const SEARCH_WEIGHTS: SearchWeights = { caution: 1, beyond: 0.25, pull: 1 };

/**
 * What the search maximises for a voice with features `f` and genome distance `dist2` (squared)
 * from the default: the reward the model is fairly sure of, less a penalty for going beyond what
 * the listener has heard, less a pull back to the default voice. A linear reward alone always
 * says "more", so without the last two the search would run off as the spectrogram score did.
 */
export function objective(m: Model, f: number[], dist2: number, heard: number[][], reachD: number, sw: SearchWeights = SEARCH_WEIGHTS): number {
  const { mean, spread } = reward(m, f);
  const out = Math.max(0, nearest(m, f, heard) - reachD);
  // gain along the reward is at most |w| per unit, so |w| / (2 beyond) * out^2 peaks at out = beyond
  const slope = Math.hypot(...m.w);
  return mean - sw.caution * spread - (slope / (2 * sw.beyond)) * out * out - sw.pull * dist2;
}

/**
 * The next question, among `candidates` (indices into `feats`): the incumbent (the best by
 * `score`) against the voice that could most plausibly beat it (mean edge plus one spread),
 * skipping pairs already asked. With no model yet, the pair furthest apart in features among
 * those not asked, so the first answers are about differences the listener can hear.
 */
export function nextPair(feats: number[][], candidates: number[], asked: Set<string>, m: Model | null, score: (i: number) => number): [number, number] | null {
  const key = (i: number, j: number) => (i < j ? `${i}:${j}` : `${j}:${i}`);
  if (candidates.length < 2) return null;
  if (!m) {
    const s = standardOf(candidates.map((i) => feats[i]));
    let best: [number, number] | null = null;
    let far = -1;
    for (const i of candidates)
      for (const j of candidates) {
        if (j <= i || asked.has(key(i, j))) continue;
        const zi = standardise(s, feats[i]);
        const zj = standardise(s, feats[j]);
        const d = zi.reduce((t, v, k) => t + (v - zj[k]) ** 2, 0);
        if (d > far) {
          far = d;
          best = [i, j];
        }
      }
    return best;
  }
  const ranked = candidates.slice().sort((a, b) => score(b) - score(a));
  for (const inc of ranked) {
    let best = -1;
    let ucb = -Infinity;
    for (const c of candidates) {
      if (c === inc || asked.has(key(inc, c))) continue;
      const e = edge(m, feats[c], feats[inc]);
      if (e.mean + e.spread > ucb) {
        ucb = e.mean + e.spread;
        best = c;
      }
    }
    if (best >= 0) return [inc, best];
  }
  return null;
}

/**
 * Gains that play two renders at one loudness: each one's RMS over its sounding 20 ms frames
 * (within 30 dB of its loudest) brought to -20 dBFS, both lowered together if either would clip.
 * Matching the whole clip instead would let a longer silence make a voice louder.
 */
export function matchLoudness(clips: ArrayLike<number>[], rate: number): number[] {
  const target = 0.1;
  const hop = Math.max(1, Math.round(0.02 * rate));
  const gains = clips.map((x) => {
    const frames: number[] = [];
    for (let s = 0; s + hop <= x.length; s += hop) {
      let e = 0;
      for (let i = s; i < s + hop; i++) e += x[i] * x[i];
      frames.push(e / hop);
    }
    const loudest = Math.max(1e-20, ...frames);
    const sounding = frames.filter((e) => e > loudest * 1e-3);
    const rms = Math.sqrt(sounding.reduce((a, b) => a + b, 0) / Math.max(1, sounding.length));
    return rms > 1e-9 ? target / rms : 1;
  });
  let peak = 0;
  clips.forEach((x, k) => {
    for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]) * gains[k]);
  });
  const limit = peak > 0.98 ? 0.98 / peak : 1;
  return gains.map((g) => g * limit);
}
