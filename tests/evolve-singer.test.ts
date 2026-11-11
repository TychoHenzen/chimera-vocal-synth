/** The Evolve page guesses the singer's body from the recording's name. */
import { describe, expect, test } from "bun:test";
import { initEngine } from "./harness.ts";

await initEngine();
const { singerOf } = await import("../src/evolve/sweep.ts");

describe("singerOf", () => {
  test("VocalSet's m singers are male; its f singers, CSD and unknown names female", () => {
    expect(singerOf("m2_row_vibrato")).toBe("male");
    expect(singerOf("m11_caro_straight")).toBe("male");
    expect(singerOf("f7_caro_vibrato")).toBe("female");
    expect(singerOf("en042a")).toBe("female");
    expect(singerOf("my_take")).toBe("female");
  });
});
