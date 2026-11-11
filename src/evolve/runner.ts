/**
 * Evolve the voice to a recording, in the page: the optimiser (separable CMA-ES, in the engine)
 * runs on the main thread, where a generation costs almost nothing; scoring a candidate costs
 * seconds (it renders the whole clip and compares spectrograms), so the candidates of a
 * generation are spread over a pool of workers, each with its own engine.
 */
import { call } from "../wasm/chimera.ts";
import { Pool } from "./pool.ts";
import { PER_NOTE, cutClip, deal, gather, sweepWindows, unit, windowConverged, windowGenomes } from "./sweep.ts";
import type { Eval, GenRecord, Picture, ProblemInfo, RunConfig, SavedRun, SingerBody, Sweep, SweepConfig } from "./types.ts";

/** A note's genes as values (not 0..1). */
export interface NoteValues {
  shift: number;
  dur: number;
  cents: number;
  vowel: string | null;
  level: number;
}

/** How long one call of `generations` runs, and what it counts on from. */
interface GenerationsPlan {
  maxGens: number;
  evals0: number;
  elapsed0: number;
  /** the part of the best genome a generation record keeps */
  keep: (x: number[]) => number[];
  /** a sweep's window (its records count generations across windows) */
  window?: number;
  /** generations before `windowConverged` may end the window */
  minGens?: number;
}

/** Running totals carried from one sweep window to the next. */
interface Totals {
  evals: number;
  elapsed: number;
}

/** The engine's problem for notes first..last of a sweep's song. */
function windowProblem(cfg: SweepConfig, first: number, last: number) {
  const { wav, wavT0 } = cutClip(cfg.samples, cfg.rate, cfg.notes, first, last);
  return { notes: cfg.notes, first, last, wav: Array.from(wav), rate: cfg.rate, wavT0, body: cfg.body };
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
  private body: SingerBody = "female";
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

  /** A note's genes as values, live for the window being evolved; null if not reached. */
  noteValues(k: number): NoteValues | null {
    const sw = this.sweep;
    const info = this.info;
    if (!sw || !info) return null;
    const u = this.noteGenome(sw, info.nGlobal, k);
    if (!u) return null;
    const g = info.genes.slice(info.nGlobal, info.nGlobal + PER_NOTE);
    const v = u.map((x, i) => g[i].lo + Math.min(1, Math.max(0, x)) * (g[i].hi - g[i].lo));
    const ch = info.vowelChoices;
    const vowel = v[3] >= 0.5 ? ch[Math.min(ch.length - 1, Math.floor((v[3] - 0.5) * 2 * ch.length))] : null;
    return { shift: v[0], dur: v[1], cents: v[2], vowel, level: v[4] };
  }

  /** Note k's genes (0..1): the live best while its window evolves, else what the sweep settled. */
  private noteGenome(sw: Sweep, nGlobal: number, k: number): number[] | null {
    const win = sw.windows[sw.index];
    if (sw.phase === "windows" && win && k >= win[0] && k <= win[1] && this.bestX.length) {
      const b = nGlobal + (k - win[0]) * PER_NOTE;
      return this.bestX.slice(b, b + PER_NOTE);
    }
    return sw.noteX[k];
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
      body: this.body,
      cma: call("evolveState"),
      bestX: this.bestX,
      best: this.best!,
      history: this.history,
      evals: this.evals,
      elapsed: this.history.length ? this.history[this.history.length - 1].elapsed : 0,
    };
  }

  /** The state every run starts from (a sweep that was told to skip leaves `skipping` set). */
  private begin(label: string, body: SingerBody, range: [number, number]): void {
    this.running = true;
    this.stopping = false;
    this.skipping = false;
    this.error = "";
    this.status = "starting the engines";
    this.label = label;
    this.body = body;
    this.range = range;
  }

  /** Record a run's failure, unless it was stopped (a stop rejects the pool's pending jobs). */
  private fail(e: unknown): void {
    if (!this.stopping) this.error = message(e);
  }

  async start(cfg: RunConfig): Promise<void> {
    if (this.running) return;
    this.begin(cfg.label, cfg.body, [cfg.first, cfg.last]);
    this.sweep = null;
    this.emit();
    try {
      await this.run(cfg);
    } catch (e) {
      this.fail(e);
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
    this.begin(cfg.label, cfg.body, [0, cfg.notes.length - 1]);
    this.history = [];
    this.picture = this.defaultPicture = null;
    const windows = sweepWindows(cfg.notes.length, cfg.window, cfg.overlap);
    const noteX = cfg.notes.map(() => null);
    const sw: Sweep = { windows, index: 0, phase: "windows", voice: [], noteX, marks: [], full: null };
    this.sweep = sw;
    this.emit();
    const pool = (this.pool = new Pool(Math.max(1, Math.min(cfg.workers, cfg.pop))));
    try {
      let totals: Totals = { evals: 0, elapsed: 0 };
      for (; sw.index < windows.length && !this.stopping && !this.skipping; sw.index++) {
        totals = await this.evolveWindow(cfg, pool, sw, totals);
      }
      if (!this.stopping) await this.singFull(cfg, pool);
    } catch (e) {
      this.fail(e);
    } finally {
      pool.close();
      this.pool = null;
      this.running = false;
      this.status = this.error ? "" : sw.full ? "the whole section is sung" : "stopped";
      this.emit();
    }
  }

  /** Evolve the sweep's current window, then keep its voice and its notes' genes. */
  private async evolveWindow(cfg: SweepConfig, pool: Pool, sw: Sweep, totals: Totals): Promise<Totals> {
    const [first, last] = sw.windows[sw.index];
    const problem = windowProblem(cfg, first, last);
    const info = call<ProblemInfo>("evolveProblem", problem);
    const ng = info.nGlobal;
    const at = { nGlobal: ng, voice: sw.voice, noteX: sw.noteX, first, last, index: sw.index };
    const { start, scales, untouched } = windowGenomes(info.genes, at);
    call("evolveStart", { sigma: cfg.sigma, pop: cfg.pop, seed: cfg.seed + sw.index, start, scales });
    this.info = info;
    this.startX = start;
    sw.marks.push(this.history.length);
    this.status = `window ${sw.index + 1} of ${sw.windows.length}: notes ${first}-${last}`;
    this.emit();
    await pool.all(pool.size, { type: "init", problem });
    const [e] = await pool.send<Eval[]>(0, { type: "eval", xs: [start] });
    this.best = e;
    this.bestX = start.slice();
    this.showDefault(pool, untouched);
    const twice = sw.index === 0 ? 2 : 1;
    const r = await this.generations(pool, {
      maxGens: cfg.maxGens * twice,
      evals0: totals.evals + 1,
      elapsed0: totals.elapsed,
      keep: (x) => x.slice(0, ng),
      window: sw.index,
      minGens: cfg.gens * twice,
    });
    sw.voice = this.bestX.slice(0, ng);
    for (let k = first; k <= last; k++) {
      const b = ng + (k - first) * PER_NOTE;
      sw.noteX[k] = this.bestX.slice(b, b + PER_NOTE);
    }
    this.emit();
    return r;
  }

  /** Render the default voice in the background for "Hear default voice". */
  private showDefault(pool: Pool, x: number[]): void {
    pool
      .send<Picture>(0, { type: "render", x })
      .then((p) => {
        this.defaultPicture = p;
        this.emit();
      })
      .catch(() => {});
  }

  /** Sing the whole section with the sweep's genes (notes no window reached keep the defaults). */
  private async singFull(cfg: SweepConfig, pool: Pool): Promise<void> {
    const sw = this.sweep!;
    sw.phase = "full";
    const last = cfg.notes.length - 1;
    this.status = "singing the whole section";
    this.emit();
    const problem = windowProblem(cfg, 0, last);
    const info = call<ProblemInfo>("evolveProblem", problem);
    const def = info.genes.map(unit);
    const x = sw.voice.length ? sw.voice.slice() : def.slice(0, info.nGlobal);
    for (let k = 0; k <= last; k++) {
      const b = info.nGlobal + k * PER_NOTE;
      x.push(...(sw.noteX[k] ?? def.slice(b, b + PER_NOTE)));
    }
    const m = Math.min(pool.size, 2);
    await pool.all(m, { type: "init", problem });
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
    const { notes, first, last, rate, wavT0, body } = cfg;
    const problem = { notes, first, last, wav: Array.from(cfg.wav), rate, wavT0, body };
    // the main thread's engine only holds the optimiser; the workers hold the recording
    const info = call<ProblemInfo>("evolveProblem", problem);
    const resume = cfg.resume;
    const state = resume?.cma ?? null;
    const started = call<{ start: number[] }>("evolveStart", { sigma: cfg.sigma, pop: cfg.pop, seed: cfg.seed, state });
    this.info = info;
    this.startX = started.start;
    const pool = (this.pool = new Pool(Math.max(1, Math.min(cfg.workers, cfg.pop))));
    await pool.all(pool.size, { type: "init", problem });

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
    this.showDefault(pool, this.startX);
    const elapsed0 = resume ? (this.history[this.history.length - 1]?.elapsed ?? 0) : 0;
    await this.generations(pool, { maxGens: Infinity, evals0: this.evals, elapsed0, keep: (x) => x });
  }

  /**
   * A picture of the best voice so far, at most every 20 s unless forced (each render costs a
   * worker the time of a whole candidate).
   */
  private pictureRequester(pool: Pool): (force: boolean) => void {
    let lastPicture = -1e9;
    return (force) => {
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
  }

  /** Score a generation's candidates across the pool, in candidate order. */
  private async score(pool: Pool, xs: number[][]): Promise<Eval[]> {
    const hands = deal(xs, pool.size);
    const parts = await Promise.all(
      hands.map((c, i) => (c.length ? pool.send<Eval[]>(i, { type: "eval", xs: c }) : Promise.resolve([] as Eval[]))),
    );
    return gather(parts, xs.length);
  }

  /**
   * Ask, score in the pool, tell, until stopped (or after `maxGens` generations, or a sweep's
   * skip, or once a sweep's window has had `minGens` and `windowConverged`), keeping the best and
   * a record per generation; returns the running totals.
   */
  private async generations(pool: Pool, plan: GenerationsPlan): Promise<Totals> {
    const { maxGens, elapsed0, keep, window, minGens = Infinity } = plan;
    this.evals = plan.evals0;
    const first = this.history.length;
    const t0 = performance.now();
    const requestPicture = this.pictureRequester(pool);
    requestPicture(true);
    for (let g = 0; g < maxGens && !this.stopping && !this.skipping; g++) {
      if (window === undefined) this.status = "evolving";
      const xs = call<number[][]>("evolveAsk");
      const evs = await this.score(pool, xs);
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
      this.history.push(this.record(losses, told, elapsed0 + (performance.now() - t0) / 1000, keep, window));
      if (improved) requestPicture(false);
      this.emit();
      if (g + 1 >= minGens && windowConverged(this.history.slice(first))) break;
    }
    requestPicture(true);
    // let the last picture arrive before the window (or the run) moves on
    await pool.send(0, { type: "eval", xs: [] }).catch(() => {});
    return { evals: this.evals, elapsed: elapsed0 + (performance.now() - t0) / 1000 };
  }

  /** One generation's record, from its losses and what the optimiser said after them. */
  private record(
    losses: number[],
    told: { generation: number; sigma: number },
    elapsed: number,
    keep: (x: number[]) => number[],
    window: number | undefined,
  ): GenRecord {
    const sorted = losses.slice().sort((a, b) => a - b);
    return {
      // a sweep restarts the optimiser each window: count its generations across them
      gen: window === undefined ? told.generation : this.history.length + 1,
      evals: this.evals,
      elapsed,
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
    };
  }
}
