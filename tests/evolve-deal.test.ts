/**
 * A generation's candidates are dealt round-robin to the workers and the scores gathered back:
 * a score put back in the wrong slot credits one candidate with another's loss, and the
 * optimiser then steps toward the wrong voice without any error.
 */
import { describe, expect, test } from "bun:test";
import { deal, gather } from "../src/evolve/sweep.ts";

describe("deal and gather", () => {
  test("gather undoes deal for every pool size, including more workers than candidates", () => {
    for (const count of [0, 1, 5, 7, 12]) {
      const xs = Array.from({ length: count }, (_, i) => i * 10);
      for (const n of [1, 2, 3, 4, 8]) {
        const hands = deal(xs, n);
        expect(hands.length).toBe(n);
        expect(gather(hands, count)).toEqual(xs);
      }
    }
  });
  test("candidate i goes to worker i % n", () => {
    expect(deal(["a", "b", "c", "d", "e"], 2)).toEqual([["a", "c", "e"], ["b", "d"]]);
  });
});
