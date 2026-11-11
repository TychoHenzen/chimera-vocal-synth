/**
 * The pure arithmetic of a run: the singer's body, the clip around some notes, a sweep's windows
 * and their starting genomes, when a window has settled, and how a generation's candidates are
 * dealt to the workers and gathered back. No engine calls, so tests import it directly.
 */
import type { CsdNote, Gene, GenRecord, SingerBody } from "./types.ts";

/** Genes per note, after the voice's: shift_s, dur_s, cents, vowel, level_db. */
export const PER_NOTE = 5;

/**
 * The body a recording's singer most likely has, from its name: VocalSet names its singers m1-m11
 * and f1-f9 (`m2_row_vibrato`); CSD's one singer, and anything else, is taken as female.
 */
export function singerOf(label: string): SingerBody {
  return /^m\d+_/.test(label) ? "male" : "female";
}

/** The recording around notes first..last as 16-bit samples (with margin for the engine's clip). */
export function cutClip(
  samples: Float32Array,
  rate: number,
  notes: CsdNote[],
  first: number,
  last: number,
): { wav: Int16Array; wavT0: number } {
  const clip0 = Math.max(0, notes[first].start - 0.4);
  const clip1 = notes[last].end + 0.5;
  const t0 = Math.max(0, clip0 - 0.1);
  const t1 = clip1 + 0.1;
  const a = Math.floor(t0 * rate);
  const b = Math.min(samples.length, Math.ceil(t1 * rate));
  const wav = new Int16Array(Math.max(0, b - a));
  for (let i = 0; i < wav.length; i++) wav[i] = Math.max(-32768, Math.min(32767, Math.round(samples[a + i] * 32767)));
  return { wav, wavT0: t0 };
}

/** Windows of `size` notes, each starting `size - overlap` notes after the last, covering all n. */
export function sweepWindows(n: number, size: number, overlap: number): [number, number][] {
  const w = Math.max(1, Math.min(size, n));
  const step = Math.max(1, w - Math.max(0, Math.min(overlap, w - 1)));
  const out: [number, number][] = [];
  for (let a = 0; ; a += step) {
    const b = Math.min(n - 1, a + w - 1);
    out.push([Math.max(0, b - w + 1), b]);
    if (b >= n - 1) break;
  }
  return out;
}

/** A gene's default as a genome value (0..1 across its range). */
export const unit = (g: Gene) => (g.def - g.lo) / (g.hi - g.lo);

/** Where one window of notes sits in the sweep, and what the sweep has settled so far. */
export interface WindowAt {
  nGlobal: number;
  /** the voice evolved so far (empty before the first window) */
  voice: number[];
  noteX: (number[] | null)[];
  first: number;
  last: number;
  index: number;
}

/**
 * A sweep window's genomes. `start` is where the window's search begins: the voice evolved so far
 * and each note's carried genes. `untouched` is every gene at its default, which is what "Hear
 * default voice" plays. Playing `start` there played the previous windows' evolved voice under
 * the default's name.
 */
export function windowGenomes(genes: Gene[], at: WindowAt): { start: number[]; scales: number[]; untouched: number[] } {
  const { nGlobal, voice, noteX, first, last, index } = at;
  const untouched = genes.map(unit);
  const start = voice.length ? voice.slice() : untouched.slice(0, nGlobal);
  // ASSUMPTION: after the first window the voice only needs fine steps (0.35 of the new
  // notes'), and notes carried from the last window half steps; untuned guesses.
  const scales = new Array<number>(nGlobal).fill(index === 0 ? 1 : 0.35);
  for (let k = first; k <= last; k++) {
    const carried = noteX[k];
    const b = nGlobal + (k - first) * PER_NOTE;
    start.push(...(carried ?? untouched.slice(b, b + PER_NOTE)));
    scales.push(...new Array<number>(PER_NOTE).fill(carried ? 0.5 : 1));
  }
  return { start, scales, untouched };
}

/** Generations over which a window's best must still be improving. */
export const PLATEAU_GENS = 20;
/**
 * Whether a window's run (its generation records, oldest first) has settled: over the last
 * PLATEAU_GENS generations the best loss fell by under 0.5 %, and the generation's median candidate
 * is within 2 % of its best, so the population has closed in on one voice. A fixed generation
 * count moved on while the best was still falling and the population was still spread wide.
 * ASSUMPTION: 0.5 % and 2 % are guesses, not tuned against runs.
 */
export function windowConverged(h: GenRecord[]): boolean {
  if (h.length <= PLATEAU_GENS) return false;
  const now = h[h.length - 1];
  const then = h[h.length - 1 - PLATEAU_GENS];
  const gain = (then.best - now.best) / then.best;
  const spread = (now.median - now.genBest) / now.genBest;
  return gain < 0.005 && spread < 0.02;
}

/** Candidates dealt round-robin to n workers: candidate i goes to worker i % n. */
export function deal<T>(xs: T[], n: number): T[][] {
  const hands: T[][] = Array.from({ length: n }, () => []);
  xs.forEach((x, i) => hands[i % n].push(x));
  return hands;
}

/** The workers' results put back in candidate order (the inverse of `deal` over `count` items). */
export function gather<T>(parts: T[][], count: number): T[] {
  const n = parts.length;
  const out: T[] = new Array(count);
  const at = new Array<number>(n).fill(0);
  for (let i = 0; i < count; i++) out[i] = parts[i % n][at[i % n]++];
  return out;
}
