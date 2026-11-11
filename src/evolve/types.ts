/** What an Evolve run works on and records: the song, the genes, the scores, the saved file. */

export interface CsdNote {
  start: number;
  end: number;
  midi: number;
  csd: string;
  syl: { phraseEnd: boolean; [k: string]: unknown };
  phraseStart: boolean;
  prevEnd: number | null;
}
export interface Gene {
  name: string;
  lo: number;
  hi: number;
  def: number;
}
export interface ProblemInfo {
  genes: Gene[];
  seconds: number;
  clip0: number;
  bands: number;
  compNames: string[];
  compWeights: number[];
  /** what a note's vowel gene sings above 0.5 */
  vowelChoices: string[];
  /** genes before the per-note ones: the voice */
  nGlobal: number;
  /** what each of a render's ear features is (`chimera::analysis::ear`) */
  featureNames: string[];
}
export interface Eval {
  loss: number;
  comps: number[];
  gap: number;
}
export interface GenRecord {
  gen: number;
  evals: number;
  elapsed: number;
  best: number;
  genBest: number;
  mean: number;
  median: number;
  worst: number;
  sigma: number;
  comps: number[];
  gap: number;
  /** the best genome so far, each gene 0..1 across its range (a sweep keeps only the voice's) */
  x: number[];
  /** a sweep's window of notes */
  window?: number;
}
export interface Picture {
  samples: number[];
  sim: number[];
  ref: number[];
  vowels: (string | null)[];
}
/** Whose body the evolved voice starts from: the body genes centre on it. */
export type SingerBody = "male" | "female";

export interface RunConfig {
  notes: CsdNote[];
  body: SingerBody;
  first: number;
  last: number;
  /** 16-bit samples covering the clip, starting `wavT0` s into the song */
  wav: Int16Array;
  rate: number;
  wavT0: number;
  pop: number;
  sigma: number;
  seed: number;
  workers: number;
  resume?: SavedRun;
  /** shown in saved files */
  label: string;
}
export interface SweepConfig {
  notes: CsdNote[];
  body: SingerBody;
  /** the whole song, mono */
  samples: Float32Array;
  rate: number;
  /** notes per window, and how many of them the next window evolves again */
  window: number;
  overlap: number;
  /**
   * generations per window before it may move on, and the most it gets (the first window, which
   * also finds the voice, gets twice both); between the two it moves on once `windowConverged`
   */
  gens: number;
  maxGens: number;
  pop: number;
  sigma: number;
  seed: number;
  workers: number;
  label: string;
}
/** The whole section, sung with a sweep's assembled genome, and with the default voice. */
export interface FullSong {
  picture: Picture;
  eval: Eval;
  defaultPicture: Picture;
  defaultEval: Eval;
  clip0: number;
  seconds: number;
}
/** A sweep's progress: the windows of notes, and the genes each note has settled on. */
export interface Sweep {
  windows: [number, number][];
  /** the window being evolved; windows.length once all are done */
  index: number;
  phase: "windows" | "full" | "done";
  /** the voice (the first nGlobal genes, 0..1) as it stands */
  voice: number[];
  /** each note's genes (PER_NOTE, 0..1) once a window has evolved it */
  noteX: (number[] | null)[];
  /** the generation each window started at */
  marks: number[];
  full: FullSong | null;
}

export interface SavedRun {
  version: 1;
  label: string;
  first: number;
  last: number;
  /** absent in runs saved before the body was chosen: those were female */
  body?: SingerBody;
  cma: unknown;
  bestX: number[];
  best: Eval;
  history: GenRecord[];
  evals: number;
  elapsed: number;
}
