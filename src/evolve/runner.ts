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
  /** the best genome so far, each gene 0..1 across its range */
  x: number[];
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
  private listeners = new Set<() => void>();
  private pool: Pool | null = null;
  private stopping = false;
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
    const t0 = performance.now();
    const elapsed0 = resume ? this.history[this.history.length - 1]?.elapsed ?? 0 : 0;
    let lastPicture = -1e9;
    const requestPicture = (force: boolean) => {
      const now = performance.now();
      if (!force && now - lastPicture < 20000) return;
      lastPicture = now;
      const gen = this.history.length ? this.history[this.history.length - 1].gen : 0;
      pool.send<Picture>(0, { type: "render", x: this.bestX })
        .then((p) => {
          this.picture = p;
          this.pictureGen = gen;
          this.emit();
        })
        .catch(() => {});
    };
    requestPicture(true);
    pool.send<Picture>(0, { type: "render", x: this.startX })
      .then((p) => {
        this.defaultPicture = p;
        this.emit();
      })
      .catch(() => {});

    while (!this.stopping) {
      this.status = "evolving";
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
        gen: told.generation,
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
        x: this.bestX.map((v) => Math.round(v * 1000) / 1000),
      });
      if (improved) requestPicture(false);
      this.emit();
    }
    requestPicture(true);
    // let the last picture arrive before the workers are closed
    await pool.send(0, { type: "eval", xs: [] }).catch(() => {});
  }
}
