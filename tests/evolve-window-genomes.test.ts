/**
 * From a sweep's second window on, "Hear default voice" played the window's starting genome,
 * which carries the voice evolved in the earlier windows. The default must stay at the genes'
 * defaults whatever the sweep has carried.
 */
import { describe, expect, test } from "bun:test";
import { initEngine } from "./harness.ts";

await initEngine();
const { windowGenomes, PER_NOTE } = await import("../src/evolve/runner.ts");

const nGlobal = 3;
const genes = Array.from({ length: nGlobal + 2 * PER_NOTE }, (_, i) => ({ name: `g${i}`, lo: 0, hi: 4, def: 1 }));

describe("windowGenomes", () => {
  test("the first window starts from the defaults", () => {
    const { start, untouched } = windowGenomes(genes, nGlobal, [], [null, null], 0, 1, 0);
    expect(untouched).toEqual(genes.map(() => 0.25));
    expect(start).toEqual(untouched);
  });
  test("a later window starts from the evolved voice, but the default stays the default", () => {
    const voice = [0.9, 0.8, 0.7];
    const carried = new Array<number>(PER_NOTE).fill(0.6);
    const { start, untouched } = windowGenomes(genes, nGlobal, voice, [carried, null], 0, 1, 1);
    expect(start.slice(0, nGlobal)).toEqual(voice);
    expect(start.slice(nGlobal, nGlobal + PER_NOTE)).toEqual(carried);
    expect(untouched).toEqual(genes.map(() => 0.25));
  });
});
