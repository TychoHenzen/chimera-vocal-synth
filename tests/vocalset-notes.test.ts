/**
 * VocalSet excerpts as CSD notes: Italian lyrics in CSD's romanisation, legato notes joined
 * across their transitions, grace notes as melismas, and the engine reading every symbol.
 */
import { describe, expect, test } from "bun:test";
import { initEngine } from "./harness.ts";
import { italianSyllable, vocalsetToCsd } from "../tools/vocalset-notes.ts";

await initEngine();
const { call } = await import("../src/wasm/chimera.ts");

// the shape of an extended Annotated VocalSet table (made-up times, not the recording's)
const HEAD = "Sequence, Start time, End time, Duration, Type, Average F0, Median F0, Min F0, Max F0, Standard deviation F0, Average F0 in range of STD, Estimated MIDI code, Ground truth Note name, Ground Truth Frequency, Ground Truth MIDI code, Lyric, Ground Truth Note duration name, Ground Truth note duration, Interval to the previous note, Interval to the following note";
const row = (seq: number, a: number, b: number, type: string, midi: number, lyric: string) => `${seq},${a},${b},${b - a},${type},0,0,0,0,0,0,${midi || ""},,0,${midi || ""},${lyric},,,,,`;
const TABLE = [
  HEAD,
  row(1, 0, 0.1, "Rest", 0, ""),
  row(2, 0.1, 1.0, "Sound", 74, "ca"),
  row(3, 1.0, 1.1, "Transition", 0, ""),
  row(4, 1.1, 1.6, "Sound", 73, "ro"),
  row(5, 1.6, 2.0, "Rest", 0, ""),
  row(6, 2.0, 2.8, "Sound", 62, "lan"),
  row(7, 2.8, 2.9, "Transition", 0, ""),
  row(8, 2.9, 3.0, "Sound", 64, ""),
  row(9, 3.0, 3.1, "Transition", 0, ""),
  row(10, 3.1, 3.6, "Sound", 61, "gui"),
  row(11, 3.6, 3.7, "Transition", 0, ""),
  row(12, 3.7, 4.2, "Sound", 62, "scie'il"),
].join("\n");

describe("Italian syllables", () => {
  test("c, g and sc soften before e and i; the i after them only marks it", () => {
    expect(italianSyllable("ca")).toEqual(["k", "aa"]);
    expect(italianSyllable("ciao")).toEqual(["ch", "aa", "o"]);
    expect(italianSyllable("giorno")).toEqual(["j", "o", "dx", "n", "o"]);
    expect(italianSyllable("scie'il")).toEqual(["sh", "ee", "ii", "l"]);
    expect(italianSyllable("scena")).toEqual(["sh", "ee", "n", "aa"]);
  });
  test("gu, qu, z, r, rr, gn and gli", () => {
    expect(italianSyllable("gui")).toEqual(["g", "w", "ii"]);
    expect(italianSyllable("quando")).toEqual(["k", "w", "aa", "n", "d", "o"]);
    expect(italianSyllable("za")).toEqual(["t", "s", "aa"]);
    expect(italianSyllable("cre")).toEqual(["k", "dx", "ee"]);
    expect(italianSyllable("terra")).toEqual(["t", "ee", "rr", "aa"]);
    expect(italianSyllable("figlio")).toEqual(["f", "ii", "gl", "o"]);
    expect(italianSyllable("gnocchi")).toEqual(["gn", "o", "k", "ii"]);
  });
});

describe("segment table to notes", () => {
  const csv = vocalsetToCsd(TABLE);
  const lines = csv.trim().split("\n").slice(1).map((l) => l.split(","));

  test("legato notes meet in the middle of their transition; rests stay gaps", () => {
    expect(lines.map((l) => l[3])).toEqual(["k_aa", "dx_o", "l_aa_n", "aa", "g_w_ii", "sh_ee_ii_l"]);
    expect(Number(lines[0][1])).toBeCloseTo(1.05, 6);
    expect(Number(lines[1][0])).toBeCloseTo(1.05, 6);
    expect(Number(lines[1][1])).toBeCloseTo(1.6, 6);
    expect(Number(lines[2][0])).toBeCloseTo(2.0, 6);
  });

  test("the engine reads every symbol, ends the phrase at the rest and makes the grace note a melisma", () => {
    const notes = call<{ syl: { melisma: boolean | null; phraseEnd: boolean; nucleus: { ipa: string } } }[]>("csdNotes", { text: csv });
    expect(notes.length).toBe(6);
    expect(notes[0].syl.nucleus.ipa).toBe("a");
    expect(notes[1].syl.phraseEnd).toBe(true);
    expect(notes[3].syl.melisma).toBe(true);
    expect(notes[5].syl.nucleus.ipa).toBe("e");
  });
});
