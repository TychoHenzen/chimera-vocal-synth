/**
 * A sweep window moved on after a fixed generation count while its best loss was still falling
 * and its population still spread wide. It now moves on only once both have settled.
 */
import { describe, expect, test } from "bun:test";
import { initEngine } from "./harness.ts";
import type { GenRecord } from "../src/evolve/types.ts";

await initEngine();
const { windowConverged, PLATEAU_GENS } = await import("../src/evolve/sweep.ts");

/** n generations whose best falls by `drop` per generation, with the median `spread` above it. */
function run(n: number, drop: number, spread: number): GenRecord[] {
  return Array.from({ length: n }, (_, i) => {
    const best = 5 * (1 - drop) ** i;
    return { gen: i + 1, evals: 0, elapsed: 0, best, genBest: best, mean: best, median: best * (1 + spread), worst: best * 2, sigma: 0.1, comps: [], gap: 0, x: [] };
  });
}

describe("windowConverged", () => {
  test("a best still falling 1 % a generation has not settled", () => {
    expect(windowConverged(run(60, 0.01, 0.005))).toBe(false);
  });
  test("a flat best with the population spread 10 % above it has not settled", () => {
    expect(windowConverged(run(60, 0, 0.1))).toBe(false);
  });
  test("a flat best with the population closed in has settled", () => {
    expect(windowConverged(run(60, 0.0001, 0.01))).toBe(true);
  });
  test("too few generations to judge the plateau", () => {
    expect(windowConverged(run(PLATEAU_GENS, 0, 0))).toBe(false);
  });
});
