/**
 * Evolve the voice to a recording, in the page: the optimiser (separable CMA-ES, in the engine)
 * runs on the main thread, where a generation costs almost nothing; scoring a candidate costs
 * seconds (it renders the whole clip and compares spectrograms), so the candidates of a
 * generation are spread over a pool of workers, each with its own engine.
 */
import { call } from "../wasm/chimera.ts";
import type { FromWorker, Job, ToWorker } from "./worker.ts";

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
}
/** Genes per note, after the voice's: shift_s, dur_s, cents, vowel, level_db. */
export const PER_NOTE = 5;
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
export interface RunConfig {
  notes: CsdNote[];
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
  /** the whole song, mono */
  samples: Float32Array;
  rate: number;
  /** notes per window, and how many of them the next window evolves again */
  window: number;
  overlap: number;
  /** generations per window (the first window, which also finds the voice, gets twice as many) */
  gens: number;
  pop: number;
  sigma: number;
  seed: number;
  workers: number;
  label: string;
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
  /** the whole section, sung with the assembled genome, and with the default voice */
  full: { picture: Picture; eval: Eval; defaultPicture: Picture; defaultEval: Eval; clip0: number; seconds: number } | null;
}

/** The recording around notes first..last as 16-bit samples (with margin for the engine's clip). */
export function cutClip(samples: Float32Array, rate: number, notes: CsdNote[], first: number, last: number): { wav: Int16Array; wavT0: number } {
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

const unit = (g: Gene) => (g.def - g.lo) / (g.hi - g.lo);

export interface SavedRun {
  version: 1;
  label: string;
  first: number;
  last: number;
  cma: unknown;
  bestX: number[];
  best: Eval;
  history: GenRecord[];
  evals: number;
  elapsed: number;
}

class Pool {
  private workers: Worker[] = [];
  private pending = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
  private next = 1;

  constructor(n: number) {
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (ev: MessageEvent<FromWorker>) => {
        const p = this.pending.get(ev.data.id);
        if (!p) return;
        this.pending.delete(ev.data.id);
        if (ev.data.type === "done") p.ok(ev.data.result);
        else p.fail(new Error(ev.data.error));
      };
      w.onerror = (ev) => {
        // a worker that dies takes its jobs with it
        for (const p of this.pending.values()) p.fail(new Error(ev.message || "worker failed"));
        this.pending.clear();
      };
      this.workers.push(w);
    }
  }

  get size(): number {
    return this.workers.length;
  }

  send<T>(i: number, m: Job): Promise<T> {
    const id = this.next++;
    return new Promise<T>((ok, fail) => {
      this.pending.set(id, { ok: ok as (v: unknown) => void, fail });
      this.workers[i].postMessage({ ...m, id } as ToWorker);
    });
  }

  close(): void {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    for (const p of this.pending.values()) p.fail(new Error("stopped"));
    this.pending.clear();
  }
}

export class EvolveRunner {
  info: ProblemInfo | null = null;
  history: GenRecord[] = [];
  best: Eval | null = null;
  bestX: number[] = [];
  startX: number[] = [];
  evals = 0;
  running = false;
  status = "";
  error = "";
  /** the latest render of the best voice, with spectrogram pictures */
  picture: Picture | null = null;
  /** the untouched default voice, to compare by ear */
  defaultPicture: Picture | null = null;
  pictureGen = -1;
  /** set while (and after) a sweep runs */
  sweep: Sweep | null = null;
  private listeners = new Set<() => void>();
  private pool: Pool | null = null;
  private stopping = false;
  private skipping = false;
  private label = "";
  private range: [number, number] = [0, 0];

  subscribe(f: () => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }
  private emit(): void {
    for (const f of this.listeners) f();
  }

  stop(): void {
    this.stopping = true;
    this.status = "stopping after this generation";
    this.emit();
  }

  /** End the sweep's current window now and sing the whole section with what it has. */
  skipToFull(): void {
    this.skipping = true;
    this.status = "finishing this window, then the whole section";
    this.emit();
  }

  /** A note's genes as values (not 0..1), live for the window being evolved; null if not reached. */
  noteValues(k: number): { shift: number; dur: number; cents: number; vowel: string | null; level: number } | null {
    const sw = this.sweep;
    const info = this.info;
    if (!sw || !info) return null;
    const win = sw.windows[sw.index];
    let u: number[] | null = sw.noteX[k];
    if (sw.phase === "windows" && win && k >= win[0] && k <= win[1] && this.bestX.length) {
      const b = info.nGlobal + (k - win[0]) * PER_NOTE;
      u = this.bestX.slice(b, b + PER_NOTE);
    }
    if (!u) return null;
    const g = info.genes.slice(info.nGlobal, info.nGlobal + PER_NOTE);
    const v = u.map((x, i) => g[i].lo + Math.min(1, Math.max(0, x)) * (g[i].hi - g[i].lo));
    const ch = info.vowelChoices;
    return { shift: v[0], dur: v[1], cents: v[2], vowel: v[3] >= 0.5 ? ch[Math.min(ch.length - 1, Math.floor((v[3] - 0.5) * 2 * ch.length))] : null, level: v[4] };
  }

  /** Render a genome in a worker (the pool outlives a stopped run only until it finishes). */
  async render(x: number[]): Promise<Picture> {
    if (!this.pool) throw new Error("no run to render from");
    return this.pool.send<Picture>(0, { type: "render", x });
  }

  save(): SavedRun {
    return {
      version: 1,
      label: this.label,
      first: this.range[0],
      last: this.range[1],
      cma: call("evolveState"),
      bestX: this.bestX,
      best: this.best!,
      history: this.history,
      evals: this.evals,
      elapsed: this.history.length ? this.history[this.history.length - 1].elapsed : 0,
    };
  }

  async start(cfg: RunConfig): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.error = "";
    this.status = "starting the engines";
    this.label = cfg.label;
    this.range = [cfg.first, cfg.last];
    this.sweep = null;
    this.emit();
    try {
      await this.run(cfg);
    } catch (e) {
      if (!this.stopping) this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.pool?.close();
      this.pool = null;
      this.running = false;
      this.status = this.error ? "" : "stopped";
      this.emit();
    }
  }

  /**
   * Evolve a song a window of notes at a time: each window starts from the voice so far and the
   * genes of the notes it shares with the last window, and searches the voice in smaller steps
   * than its own new notes. Then the whole section is sung with the assembled genome.
   */
  async startSweep(cfg: SweepConfig): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.skipping = false;
    this.error = "";
    this.label = cfg.label;
    this.history = [];
    this.picture = this.defaultPicture = null;
    this.status = "starting the engines";
    const windows = sweepWindows(cfg.notes.length, cfg.window, cfg.overlap);
    this.range = [0, cfg.notes.length - 1];
    const sw: Sweep = { windows, index: 0, phase: "windows", voice: [], noteX: cfg.notes.map(() => null), marks: [], full: null };
    this.sweep = sw;
    this.emit();
    const n = Math.max(1, Math.min(cfg.workers, cfg.pop));
    const pool = (this.pool = new Pool(n));
    try {
      let evals = 0;
      let elapsed = 0;
      for (; sw.index < windows.length && !this.stopping && !this.skipping; sw.index++) {
        const [first, last] = windows[sw.index];
        const { wav, wavT0 } = cutClip(cfg.samples, cfg.rate, cfg.notes, first, last);
        const problem = { notes: cfg.notes, first, last, wav: Array.from(wav), rate: cfg.rate, wavT0 };
        const info = call<ProblemInfo>("evolveProblem", problem);
        const ng = info.nGlobal;
        const def = info.genes.map(unit);
        if (!sw.voice.length) sw.voice = def.slice(0, ng);
        const start = sw.voice.slice();
        // ASSUMPTION: after the first window the voice only needs fine steps (0.35 of the new
        // notes'), and notes carried from the last window half steps; untuned guesses.
        const scales = new Array<number>(ng).fill(sw.index === 0 ? 1 : 0.35);
        for (let k = first; k <= last; k++) {
          const carried = sw.noteX[k];
          const b = ng + (k - first) * PER_NOTE;
          start.push(...(carried ?? def.slice(b, b + PER_NOTE)));
          scales.push(...new Array<number>(PER_NOTE).fill(carried ? 0.5 : 1));
        }
        call("evolveStart", { sigma: cfg.sigma, pop: cfg.pop, seed: cfg.seed + sw.index, start, scales });
        this.info = info;
        this.startX = start;
        sw.marks.push(this.history.length);
        this.status = `window ${sw.index + 1} of ${windows.length}: notes ${first}-${last}`;
        this.emit();
        await Promise.all(Array.from({ length: n }, (_, i) => pool.send(i, { type: "init", problem })));
        const [e] = await pool.send<Eval[]>(0, { type: "eval", xs: [start] });
        this.best = e;
        this.bestX = start.slice();
        pool
          .send<Picture>(0, { type: "render", x: start })
          .then((p) => {
            this.defaultPicture = p;
            this.emit();
          })
          .catch(() => {});
        const r = await this.generations(pool, n, sw.index === 0 ? cfg.gens * 2 : cfg.gens, evals + 1, elapsed, (x) => x.slice(0, ng), sw.index);
        evals = r.evals;
        elapsed = r.elapsed;
        sw.voice = this.bestX.slice(0, ng);
        for (let k = first; k <= last; k++) {
          const b = ng + (k - first) * PER_NOTE;
          sw.noteX[k] = this.bestX.slice(b, b + PER_NOTE);
        }
        this.emit();
      }
      if (!this.stopping) await this.singFull(cfg, pool, n);
    } catch (e) {
      if (!this.stopping) this.error = e instanceof Error ? e.message : String(e);
    } finally {
      pool.close();
      this.pool = null;
      this.running = false;
      this.status = this.error ? "" : sw.full ? "the whole section is sung" : "stopped";
      this.emit();
    }
  }

  /** Sing the whole section with the sweep's genes (notes no window reached keep the defaults). */
  private async singFull(cfg: SweepConfig, pool: Pool, n: number): Promise<void> {
    const sw = this.sweep!;
    sw.phase = "full";
    const last = cfg.notes.length - 1;
    this.status = "singing the whole section";
    this.emit();
    const { wav, wavT0 } = cutClip(cfg.samples, cfg.rate, cfg.notes, 0, last);
    const problem = { notes: cfg.notes, first: 0, last, wav: Array.from(wav), rate: cfg.rate, wavT0 };
    const info = call<ProblemInfo>("evolveProblem", problem);
    const def = info.genes.map(unit);
    const x = sw.voice.length ? sw.voice.slice() : def.slice(0, info.nGlobal);
    for (let k = 0; k <= last; k++) {
      const b = info.nGlobal + k * PER_NOTE;
      x.push(...(sw.noteX[k] ?? def.slice(b, b + PER_NOTE)));
    }
    const m = Math.min(n, 2);
    await Promise.all(Array.from({ length: m }, (_, i) => pool.send(i, { type: "init", problem })));
    // the assembled voice and the default one, side by side on two workers
    const [picture, defaultPicture, [e], [de]] = await Promise.all([
      pool.send<Picture>(0, { type: "render", x }),
      pool.send<Picture>(m - 1, { type: "render", x: def }),
      pool.send<Eval[]>(0, { type: "eval", xs: [x] }),
      pool.send<Eval[]>(m - 1, { type: "eval", xs: [def] }),
    ]);
    sw.full = { picture, eval: e, defaultPicture, defaultEval: de, clip0: info.clip0, seconds: info.seconds };
    sw.phase = "done";
  }

  private async run(cfg: RunConfig): Promise<void> {
    const problem = { notes: cfg.notes, first: cfg.first, last: cfg.last, wav: Array.from(cfg.wav), rate: cfg.rate, wavT0: cfg.wavT0 };
    // the main thread's engine only holds the optimiser; the workers hold the recording
    const info = call<ProblemInfo>("evolveProblem", problem);
    const resume = cfg.resume;
    const started = call<{ start: number[] }>("evolveStart", { sigma: cfg.sigma, pop: cfg.pop, seed: cfg.seed, state: resume?.cma ?? null });
    this.info = info;
    this.startX = started.start;
    const n = Math.max(1, Math.min(cfg.workers, cfg.pop));
    const pool = (this.pool = new Pool(n));
    await Promise.all(Array.from({ length: n }, (_, i) => pool.send(i, { type: "init", problem })));

    if (resume) {
      this.history = resume.history;
      this.bestX = resume.bestX;
      this.best = resume.best;
      this.evals = resume.evals;
    } else {
      this.history = [];
      this.status = "scoring the default voice";
      this.emit();
      const [e] = await pool.send<Eval[]>(0, { type: "eval", xs: [this.startX] });
      this.best = e;
      this.bestX = this.startX.slice();
      this.evals = 1;
    }
    pool
      .send<Picture>(0, { type: "render", x: this.startX })
      .then((p) => {
        this.defaultPicture = p;
        this.emit();
      })
      .catch(() => {});
    const elapsed0 = resume ? (this.history[this.history.length - 1]?.elapsed ?? 0) : 0;
    await this.generations(pool, n, Infinity, this.evals, elapsed0, (x) => x);
  }

  /**
   * Ask, score in the pool, tell, until stopped (or after `maxGens` generations, or a sweep's
   * skip), keeping the best and a record per generation; returns the running totals.
   */
  private async generations(pool: Pool, n: number, maxGens: number, evals0: number, elapsed0: number, keep: (x: number[]) => number[], window?: number): Promise<{ evals: number; elapsed: number }> {
    this.evals = evals0;
    const t0 = performance.now();
    let lastPicture = -1e9;
    const requestPicture = (force: boolean) => {
      const now = performance.now();
      if (!force && now - lastPicture < 20000) return;
      lastPicture = now;
      const gen = this.history.length ? this.history[this.history.length - 1].gen : 0;
      pool
        .send<Picture>(0, { type: "render", x: this.bestX })
        .then((p) => {
          this.picture = p;
          this.pictureGen = gen;
          this.emit();
        })
        .catch(() => {});
    };
    requestPicture(true);
    for (let g = 0; g < maxGens && !this.stopping && !this.skipping; g++) {
      if (window === undefined) this.status = "evolving";
      const xs = call<number[][]>("evolveAsk");
      const chunks: number[][][] = Array.from({ length: n }, () => []);
      xs.forEach((x, i) => chunks[i % n].push(x));
      const parts = await Promise.all(chunks.map((c, i) => (c.length ? pool.send<Eval[]>(i, { type: "eval", xs: c }) : Promise.resolve([] as Eval[]))));
      // put the scores back in candidate order
      const evs: Eval[] = new Array(xs.length);
      const at = new Array(n).fill(0);
      xs.forEach((_, i) => (evs[i] = parts[i % n][at[i % n]++]));
      this.evals += xs.length;
      const losses = evs.map((e) => e.loss);
      let bi = 0;
      losses.forEach((l, i) => {
        if (l < losses[bi]) bi = i;
      });
      const improved = losses[bi] < this.best!.loss;
      if (improved) {
        this.best = evs[bi];
        this.bestX = xs[bi].slice();
      }
      const told = call<{ generation: number; sigma: number }>("evolveTell", { losses });
      const sorted = losses.slice().sort((a, b) => a - b);
      this.history.push({
        // a sweep restarts the optimiser each window: count its generations across them
        gen: window === undefined ? told.generation : this.history.length + 1,
        evals: this.evals,
        elapsed: elapsed0 + (performance.now() - t0) / 1000,
        best: this.best!.loss,
        genBest: sorted[0],
        mean: losses.reduce((a, b) => a + b, 0) / losses.length,
        median: sorted[sorted.length >> 1],
        worst: sorted[sorted.length - 1],
        sigma: told.sigma,
        comps: this.best!.comps,
        gap: this.best!.gap,
        x: keep(this.bestX).map((v) => Math.round(v * 1000) / 1000),
        window,
      });
      if (improved) requestPicture(false);
      this.emit();
    }
    requestPicture(true);
    // let the last picture arrive before the window (or the run) moves on
    await pool.send(0, { type: "eval", xs: [] }).catch(() => {});
    return { evals: this.evals, elapsed: elapsed0 + (performance.now() - t0) / 1000 };
  }
}
