/**
 * The "learn from my ear" preference model on made-up listeners whose taste is known: it must
 * recover the taste from a few dozen answers, treat "same" as no preference, keep the search
 * near what was heard, and play every candidate at one loudness.
 */
import { describe, expect, test } from "bun:test";
import { agreement, fit, matchLoudness, nextPair, objective, reach, reward, rng, type Pair } from "../src/evolve/preference.ts";

const D = 19;

function voices(n: number, seed: number): number[][] {
  const r = rng(seed);
  // features on very different scales, as the real ones are (dB, logs, ratios)
  return Array.from({ length: n }, () => Array.from({ length: D }, (_, k) => (r() - 0.5) * (1 + k * 3) + k));
}

/** A listener who prefers whichever voice is higher on `taste` (on the standardised features). */
function answers(feats: number[][], taste: number[], n: number, seed: number): Pair[] {
  const r = rng(seed);
  const scale = feats[0].map((_, k) => 1 + k * 3);
  const u = (f: number[]) => f.reduce((t, v, k) => t + (taste[k] * v) / scale[k], 0);
  return Array.from({ length: n }, () => {
    const a = feats[Math.floor(r() * feats.length)];
    const b = feats[Math.floor(r() * feats.length)];
    return { a, b, y: u(a) > u(b) ? 1 : 0 };
  });
}

const corr = (a: number[], b: number[]) => {
  const ma = a.reduce((x, y) => x + y) / a.length;
  const mb = b.reduce((x, y) => x + y) / b.length;
  const c = a.reduce((t, v, i) => t + (v - ma) * (b[i] - mb), 0);
  return c / Math.sqrt(a.reduce((t, v) => t + (v - ma) ** 2, 0) * b.reduce((t, v) => t + (v - mb) ** 2, 0));
};

describe("preference model", () => {
  const feats = voices(40, 7);
  // a listener who cares about three features: likes 2 and 11, dislikes 5
  const taste = new Array<number>(D).fill(0);
  taste[2] = 1;
  taste[5] = -1;
  taste[11] = 0.7;

  test("30 answers recover which voices the listener prefers", () => {
    const pairs = answers(feats, taste, 30, 3);
    const m = fit(pairs, feats);
    const truth = feats.map((f) => f.reduce((t, v, k) => t + (taste[k] * v) / (1 + k * 3), 0));
    const learned = feats.map((f) => reward(m, f).r);
    // 30 random pairs over 19 features recover the taste at r = 0.79 (seed 3)
    expect(corr(truth, learned)).toBeGreaterThan(0.7);
    const { right, of } = agreement(pairs, feats);
    expect(right / of).toBeGreaterThan(0.75);
  });

  test("answering 'same' every time learns no preference", () => {
    const pairs = answers(feats, taste, 20, 4).map((p) => ({ ...p, y: 0.5 }));
    const m = fit(pairs, feats);
    expect(Math.max(...m.w.map(Math.abs))).toBeLessThan(1e-6);
  });

  test("more of what the listener liked stops paying beyond what they have heard", () => {
    // a linear reward always says "more": the trust penalty must win far enough out
    const pairs = answers(feats, taste, 30, 5);
    const m = fit(pairs, feats);
    const heard = pairs.flatMap((p) => [p.a, p.b]);
    const d = reach(m, heard);
    // the voice the model likes best among those heard, and ten deviations further its way
    const near = heard.reduce((a, b) => (reward(m, b).r > reward(m, a).r ? b : a));
    const norm = Math.hypot(...m.w);
    const far = near.map((v, k) => v + 10 * (m.w[k] / norm) * m.standard.std[k]);
    expect(reward(m, far).mean).toBeGreaterThan(reward(m, near).mean);
    expect(objective(m, far, 0, heard, d)).toBeLessThan(objective(m, near, 0, heard, d));
  });

  test("the first questions pair the most different voices, and never repeat a pair", () => {
    const f = [[0, 0], [1, 0], [10, 10], [0, 1]];
    const first = nextPair(f, [0, 1, 2, 3], new Set(), null, () => 0);
    expect(first).toEqual([0, 2]);
    const second = nextPair(f, [0, 1, 2, 3], new Set(["0:2"]), null, () => 0);
    expect(second).not.toEqual([0, 2]);
  });
});

describe("matchLoudness", () => {
  const rate = 48000;
  const tone = (amp: number, silent: number) => {
    const x = new Float32Array(rate + silent);
    for (let i = 0; i < rate; i++) x[silent + i] = amp * Math.sin((2 * Math.PI * 220 * i) / rate);
    return x;
  };

  test("a quiet clip with a long silence plays as loud as a loud one without", () => {
    const a = tone(0.5, 0);
    const b = tone(0.02, 3 * rate);
    const [ga, gb] = matchLoudness([a, b], rate);
    expect(Math.abs(0.5 * ga - 0.02 * gb) / (0.5 * ga)).toBeLessThan(0.02);
  });

  test("neither clip clips", () => {
    const a = tone(0.5, 0);
    const spiky = tone(0.05, 0);
    spiky[100] = 0.9;
    const g = matchLoudness([a, spiky], rate);
    expect(Math.abs(spiky[100] * g[1])).toBeLessThanOrEqual(0.98 + 1e-9);
  });
});
