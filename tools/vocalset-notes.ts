#!/usr/bin/env bun
/**
 * Turn an Annotated VocalSet segment table ("extended" form: Sequence, Start time, End time,
 * Duration, Type, ... Ground Truth MIDI code, Lyric, ...) into a CSD notes file
 * (`start,end,pitch,syllable`, phonemes joined with `_` in CSD's romanisation), so the Evolve page
 * and `csd::parse` can sing the excerpt.
 *
 * - Sound rows are notes. A Transition row between two notes is split at its middle, so legato
 *   notes touch; next to a Rest it belongs to the note. Rest rows stay gaps.
 * - A Sound row with no lyric (a grace note) sings the previous note's vowel: `csd::parse` makes
 *   it a melisma.
 * - Caro mio ben and the Latin of Dona nobis pacem are spelled as Italian (`italianSyllable`);
 *   the English Row your boat (keys with `_row_`) is looked up syllable by syllable
 *   (`englishSyllable`), since its 27 syllables are the same in every table.
 *
 * usage: bun tools/vocalset-notes.ts <segment csv> [out csv]
 *        (an input file name containing `_row_` is read as English)
 */
import { readFileSync, writeFileSync } from "node:fs";

interface Row {
  start: number;
  end: number;
  type: string;
  midi: number;
  lyric: string;
}

function rows(text: string): Row[] {
  const out: Row[] = [];
  for (const line of text.split(/\r?\n/).slice(1)) {
    const f = line.split(",").map((s) => s.trim());
    if (f.length < 16) continue;
    const gt = Number(f[14]);
    const est = Number(f[11]);
    out.push({ start: Number(f[1]), end: Number(f[2]), type: f[4], midi: gt > 0 ? gt : Number.isFinite(est) && est > 0 ? Math.round(est) : 0, lyric: f[15] });
  }
  return out;
}

const VOWEL: Record<string, string> = { a: "aa", e: "ee", i: "ii", o: "o", u: "uu" };
const SUNG = new Set(Object.values(VOWEL));
const ENGLISH_VOWELS = new Set(["ou", "oo", "ii", "e", "au", "eo", "i", "ai", "ao", "er", "a", "ae", "ei", "oi", "u", "uu"]);
const isVowel = (ch: string | undefined) => ch !== undefined && ch in VOWEL;
const front = (ch: string | undefined) => ch === "e" || ch === "i";

/**
 * One sung syllable of Italian in CSD's romanisation, extended with `aa ee o` (pure vowels),
 * `dx` (tap), `rr` (trill), `gn` and `gl` (palatals). Elisions written with `'` (`mi'al`) sing
 * as one syllable.
 * ASSUMPTION: a single r is a tap and rr a trill; a word-initial r would be trilled, but the
 * table splits words into syllables without marking word starts.
 */
export function italianSyllable(text: string): string[] {
  const s = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z]/g, "");
  const out: string[] = [];
  const push = (p: string) => {
    // a doubled consonant sings as one
    if (out.length && out[out.length - 1] === p && !SUNG.has(p)) return;
    out.push(p);
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const n1 = s[i + 1];
    const n2 = s[i + 2];
    if (isVowel(c)) {
      push(VOWEL[c]);
      i += 1;
    } else if (c === "s" && n1 === "c" && front(n2)) {
      push("sh");
      // the i of "scia", "scio" only marks the sound
      i += n2 === "i" && isVowel(s[i + 3]) ? 3 : 2;
    } else if ((c === "c" || c === "g") && n1 === "h") {
      push(c === "c" ? "k" : "g");
      i += 2;
    } else if (c === "c" || c === "g") {
      if (c === "g" && n1 === "n") {
        push("gn");
        i += 2;
      } else if (c === "g" && n1 === "l" && n2 === "i") {
        push("gl");
        i += isVowel(s[i + 3]) ? 3 : 2;
      } else if (front(n1)) {
        push(c === "c" ? "ch" : "j");
        i += n1 === "i" && isVowel(n2) ? 2 : 1;
      } else if (c === "g" && n1 === "u" && isVowel(n2)) {
        push("g");
        push("w");
        i += 2;
      } else {
        push(c === "c" ? "k" : "g");
        i += 1;
      }
    } else if (c === "q") {
      push("k");
      if (n1 === "u") {
        push("w");
        i += 2;
      } else i += 1;
    } else if (c === "z") {
      push("t");
      push("s");
      i += n1 === "z" ? 2 : 1;
    } else if (c === "r") {
      push(n1 === "r" ? "rr" : "dx");
      i += n1 === "r" ? 2 : 1;
    } else if (c === "h") {
      i += 1;
    } else if (c === "x") {
      push("k");
      push("s");
      i += 1;
    } else if (c === "j") {
      push("y");
      i += 1;
    } else {
      push(c);
      i += 1;
    }
  }
  return out;
}

/**
 * Row your boat's syllables, as the tables split them, in CSD's (American English) phonemes.
 * ASSUMPTION: "your" rhymes with "or" and "merrily" is mer.ri.ly with the r closing "mer" (General American).
 */
const ROW_YOUR_BOAT: Record<string, string> = {
  row: "r_ou",
  your: "y_oo_r",
  boat: "b_ou_t",
  gent: "j_e_n_t",
  ly: "l_ii",
  down: "d_au_n",
  the: "dh_eo",
  stream: "s_t_r_ii_m",
  mer: "m_e_r",
  ri: "r_i",
  life: "l_ai_f",
  is: "i_z",
  but: "b_ao_t",
  a: "eo",
  dream: "d_r_ii_m",
};

/** One syllable of Row your boat; any other English throws (there is no general speller). */
export function englishSyllable(text: string): string[] {
  const w = text.toLowerCase().replace(/[^a-z]/g, "");
  const p = ROW_YOUR_BOAT[w];
  if (!p) throw new Error(`no English spelling for "${text}" (only Row your boat's syllables are known)`);
  return p.split("_");
}

export type Lyrics = "italian" | "english";

/** The language of a VocalSet excerpt, from its key or file name. */
export const lyricsOf = (key: string): Lyrics => (key.includes("_row_") ? "english" : "italian");

/** The CSD notes file for a VocalSet segment table. */
export function vocalsetToCsd(text: string, lyrics: Lyrics = "italian"): string {
  const spell = lyrics === "english" ? englishSyllable : italianSyllable;
  const sung = (p: string) => SUNG.has(p) || ENGLISH_VOWELS.has(p);
  const rs = rows(text);
  const notes: { start: number; end: number; midi: number; syl: string }[] = [];
  let lastVowel = "aa";
  for (let k = 0; k < rs.length; k++) {
    const r = rs[k];
    if (r.type !== "Sound") continue;
    let start = r.start;
    let end = r.end;
    const prev = rs[k - 1];
    const next = rs[k + 1];
    if (prev?.type === "Transition") start = rs[k - 2]?.type === "Sound" ? (prev.start + prev.end) / 2 : prev.start;
    if (next?.type === "Transition") end = rs[k + 2]?.type === "Sound" ? (next.start + next.end) / 2 : next.end;
    const phones = r.lyric ? spell(r.lyric) : [];
    const vowels = phones.filter(sung);
    const syl = phones.length && vowels.length ? phones.join("_") : lastVowel;
    if (vowels.length) lastVowel = vowels[vowels.length - 1];
    notes.push({ start, end, midi: r.midi, syl });
  }
  const f = (x: number) => x.toFixed(5).replace(/\.?0+$/, "");
  return ["start,end,pitch,syllable", ...notes.map((n) => `${f(n.start)},${f(n.end)},${n.midi},${n.syl}`)].join("\n") + "\n";
}

if (import.meta.main) {
  const [inp, outp] = process.argv.slice(2);
  if (!inp) {
    console.error("usage: bun tools/vocalset-notes.ts <segment csv> [out csv]");
    process.exit(2);
  }
  const csv = vocalsetToCsd(readFileSync(inp, "utf8"), lyricsOf(inp));
  if (outp) writeFileSync(outp, csv);
  else process.stdout.write(csv);
}
