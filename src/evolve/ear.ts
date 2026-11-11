/**
 * Evolve's "learn from my ear" mode: the listener answers occasional A/B questions, a preference
 * model (preference.ts) learns their taste from the answers, and a search (the engine's CMA-ES,
 * over the voice's genes only) looks for the voice the model rates best while staying where the
 * answers reach. The spectrogram score is not used: it rewarded a buzz the listener rejected.
 *
 * Every voice rendered (the default, a spread of variations to start the questions, and every
 * candidate the search tries) goes into an archive with its ear features, so a refit re-rates the
 * whole archive without rendering anything again. The questions come from the archive: the voice
 * the model rates best against the one most likely to beat it.
 *
 * Answers are saved by gene name (out/evolve/ear-answers.json through the dev server, and in the
 * browser), so they outlive a change of clip or a change to the genome; on a new clip the voices
 * answered about are rendered again.
 */
import { call } from "../wasm/chimera.ts";
import { agreement, fit, matchLoudness, nextPair, objective, reach, reward, rng, SEARCH_WEIGHTS, standardise, standardOf, type Model, type Pair, type SearchWeights } from "./preference.ts";
import { Pool, unit, type CsdNote, type ProblemInfo, type SingerBody } from "./runner.ts";

/**
 * Genes the search leaves at the default. Some the ear cannot judge here: loudness (playback
 * matches it), timing, and what the recording's pitch contour overrides (in the leave-one-out
 * ranking each moved the loss by 0.000). The rest the live voice cannot play, so a favourite that
 * leaned on them would sound different on the other pages: the loudness shape inside each note and
 * the loudness wobble (the instrument sings at the level its keys and breath set).
 */
export const FROZEN_GENES = [
  "gain_db", "time_shift_s", "lung_pressure", "vibrato_cents", "vibrato_rate_hz", "pitch_drift",
  "dyn_start_db", "dyn_mid_db", "dyn_end_db", "tremolo_db", "tremolo_hz",
];
// ASSUMPTION: 10 variations at a step of 0.12 (of each gene's range) are different enough to hear
// and few enough to judge; untuned.
const EXPLORE = 10;
const EXPLORE_STEP = 0.12;
const POP = 16;
const SEARCH_SIGMA = 0.08;
/** Questions come from the voices the search rates best, plus these. */
const SHORTLIST = 40;
const FILE = "ear-answers.json";
const STORE = "chimera.ear.answers";

/** One answer, by gene name and value, so it survives a change of genome. */
export interface Answer {
  a: Record<string, number>;
  b: Record<string, number>;
  /** 1: A was better, 0: B was, 0.5: the same */
  y: number;
  /** ms since 1970 */
  at: number;
}

export interface Voice {
  /** the whole genome, 0..1 per gene (the notes' genes at their defaults) */
  x: number[];
  f: number[];
  /** squared distance of the searched genes from the default */
  dist2: number;
  origin: "default" | "variation" | "answered" | "search";
  /** what the search maximises, under the current model */
  score: number;
}

export interface Question {
  /** archive indices of the voices playing as A and as B (the order is random) */
  a: number;
  b: number;
  samples: [Float32Array, Float32Array];
  gains: [number, number];
  /** how far apart the two voices' features are (standardised, root mean square per feature) */
  apart: number;
}

export interface EarConfig {
  notes: CsdNote[];
  body: SingerBody;
  first: number;
  last: number;
  wav: Int16Array;
  rate: number;
  wavT0: number;
  workers: number;
  seed: number;
}

export class EarRunner {
  info: ProblemInfo | null = null;
  voices: Voice[] = [];
  answers: Answer[] = [];
  model: Model | null = null;
  /** leave-one-out: decisive answers a fit on the others predicts */
  agree = { right: 0, of: 0 };
  question: Question | null = null;
  /** the voice the model rates best and the default, rendered, to compare outside the questions */
  favourite: { index: number; samples: Float32Array[]; gains: number[] } | null = null;
  weights: SearchWeights = { ...SEARCH_WEIGHTS };
  /** the body the voices are evolved on */
  body: SingerBody = "female";
  generations = 0;
  running = false;
  status = "";
  error = "";
  private listeners = new Set<() => void>();
  private pool: Pool | null = null;
  private stopping = false;
  /** the answered pairs, as archive indices */
  private pairs: { a: number; b: number; y: number }[] = [];
  private asked = new Set<string>();
  private searched: number[] = [];
  private def: number[] = [];
  private restart = true;
  private wake: (() => void) | null = null;
  private seed = 1;
  /** a question is being chosen and rendered (an answer and the search may both ask) */
  private asking = false;

  subscribe(f: () => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }
  private emit(): void {
    for (const f of this.listeners) f();
  }

  stop(): void {
    this.stopping = true;
    this.status = "stopping";
    this.wake?.();
    this.emit();
  }

  /** The voice the model rates best, by archive index. */
  get best(): number {
    let b = 0;
    this.voices.forEach((v, i) => {
      if (v.score > this.voices[b].score) b = i;
    });
    return b;
  }

  /** The learned weight of each feature (standardised units: reward per standard deviation). */
  get learned(): { name: string; w: number }[] {
    const names = this.info?.featureNames ?? [];
    return this.model ? names.map((name, i) => ({ name, w: this.model!.w[i] })) : [];
  }

  /** A genome as gene values by name (the voice's genes only). */
  named(x: number[]): Record<string, number> {
    const out: Record<string, number> = {};
    this.info!.genes.slice(0, this.info!.nGlobal).forEach((g, i) => (out[g.name] = g.lo + x[i] * (g.hi - g.lo)));
    return out;
  }

  private genome(named: Record<string, number>): number[] {
    return this.info!.genes.map((g, i) => (g.name in named && i < this.info!.nGlobal ? Math.min(1, Math.max(0, (named[g.name] - g.lo) / (g.hi - g.lo))) : this.def[i]));
  }

  private dist2(x: number[]): number {
    return this.searched.reduce((t, i) => t + (x[i] - this.def[i]) ** 2, 0);
  }

  async start(cfg: EarConfig): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.error = "";
    this.body = cfg.body;
    this.seed = cfg.seed;
    this.voices = [];
    this.pairs = [];
    this.asked.clear();
    this.model = null;
    this.agree = { right: 0, of: 0 };
    this.question = this.favourite = null;
    this.generations = 0;
    // evolveProblem below drops the main thread's optimiser: the search must start a new one
    this.restart = true;
    this.status = "starting the engines";
    this.emit();
    const problem = { notes: cfg.notes, first: cfg.first, last: cfg.last, wav: Array.from(cfg.wav), rate: cfg.rate, wavT0: cfg.wavT0, body: cfg.body };
    const n = Math.max(2, cfg.workers);
    const pool = (this.pool = new Pool(n));
    try {
      const info = call<ProblemInfo>("evolveProblem", problem);
      this.info = info;
      this.def = info.genes.map(unit);
      this.searched = info.genes.slice(0, info.nGlobal).flatMap((g, i) => (FROZEN_GENES.includes(g.name) ? [] : [i]));
      await Promise.all(Array.from({ length: n }, (_, i) => pool.send(i, { type: "init", problem })));
      this.answers = await loadAnswers();

      // the archive to start from: the default, every voice answered about, and variations
      this.status = "rendering the first voices";
      this.emit();
      const r = rng(cfg.seed);
      const gauss = () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
      const seeds: { x: number[]; origin: Voice["origin"] }[] = [{ x: this.def.slice(), origin: "default" }];
      const keyOf = (x: number[]) => x.map((v) => v.toFixed(4)).join(",");
      const index = new Map<string, number>([[keyOf(this.def), 0]]);
      const answered = this.answers.map((a) => [a.a, a.b].map((named) => {
        const x = this.genome(named);
        const k = keyOf(x);
        if (!index.has(k)) {
          index.set(k, seeds.length);
          seeds.push({ x, origin: "answered" });
        }
        return index.get(k)!;
      }));
      for (let k = 0; k < EXPLORE; k++) {
        const x = this.def.slice();
        for (const i of this.searched) x[i] = Math.min(1, Math.max(0, x[i] + EXPLORE_STEP * gauss()));
        seeds.push({ x, origin: "variation" });
      }
      const feats = await this.features(pool, seeds.map((s) => s.x));
      // archive index 0 is the default everywhere (the shortlist, renderFavourite)
      if (!feats[0]) throw new Error("the default voice did not render");
      seeds.forEach((s, k) => feats[k] && this.voices.push({ x: s.x, f: feats[k]!, dist2: this.dist2(s.x), origin: s.origin, score: 0 }));
      // a voice that blew up drops out, so map seed positions to archive positions
      const at: number[] = [];
      let v = 0;
      feats.forEach((f) => at.push(f ? v++ : -1));
      this.answers.forEach((a, k) => {
        const [ia, ib] = answered[k].map((s) => at[s]);
        if (ia < 0 || ib < 0) return;
        this.pairs.push({ a: ia, b: ib, y: a.y });
        this.asked.add(pairKey(ia, ib));
      });
      this.refit();
      await this.ask(pool);
      await this.search(pool);
    } catch (e) {
      if (!this.stopping) this.error = e instanceof Error ? e.message : String(e);
    } finally {
      pool.close();
      this.pool = null;
      this.running = false;
      this.status = this.error ? "" : "stopped";
      this.emit();
    }
  }

  /** Record the listener's answer to the current question and move on. */
  async answer(choice: "a" | "b" | "same"): Promise<void> {
    const q = this.question;
    const pool = this.pool;
    if (!q || !pool) return;
    const y = choice === "a" ? 1 : choice === "b" ? 0 : 0.5;
    this.question = null;
    this.pairs.push({ a: q.a, b: q.b, y });
    this.asked.add(pairKey(q.a, q.b));
    this.answers.push({ a: this.named(this.voices[q.a].x), b: this.named(this.voices[q.b].x), y, at: Date.now() });
    void saveAnswers(this.answers);
    this.refit();
    this.restart = true;
    this.wake?.();
    await this.ask(pool);
  }

  /** Refit the model to every answer and re-rate the archive. */
  private refit(): void {
    const pairs: Pair[] = this.pairs.map((p) => ({ a: this.voices[p.a].f, b: this.voices[p.b].f, y: p.y }));
    // ASSUMPTION: three answers, one of them decisive, before a fit means anything; untuned.
    if (pairs.length < 3 || !pairs.some((p) => p.y !== 0.5)) {
      this.model = null;
      this.agree = { right: 0, of: 0 };
      return;
    }
    // standardise over the voices chosen to be heard (default, variations, answered) and every
    // voice in a question, not the whole archive: the search fills the archive with near-copies of
    // its best, which would shrink every spread and loosen the fit the longer the search ran
    const heardIdx = new Set(this.pairs.flatMap((p) => [p.a, p.b]));
    const pool = this.voices.flatMap((v, i) => (v.origin !== "search" || heardIdx.has(i) ? [v.f] : []));
    this.model = fit(pairs, pool, this.seed);
    this.agree = agreement(pairs, pool);
    const heard = this.heard();
    const d = reach(this.model, heard);
    for (const v of this.voices) v.score = objective(this.model, v.f, v.dist2, heard, d, this.weights);
  }

  private heard(): number[][] {
    const idx = new Set(this.pairs.flatMap((p) => [p.a, p.b]));
    return [...idx].map((i) => this.voices[i].f);
  }

  /** Choose the next question, render both voices, and put it to the listener. */
  private async ask(pool: Pool): Promise<void> {
    if (this.asking) return;
    this.asking = true;
    try {
      await this.askNow(pool);
    } finally {
      this.asking = false;
    }
  }

  private async askNow(pool: Pool): Promise<void> {
    const m = this.model;
    let cands: number[];
    if (!m) cands = this.voices.flatMap((v, i) => (v.origin === "search" ? [] : [i]));
    else {
      const ranked = this.voices.map((_, i) => i).sort((a, b) => this.voices[b].score - this.voices[a].score);
      cands = [...new Set([...ranked.slice(0, SHORTLIST), 0])];
    }
    const pair = nextPair(
      this.voices.map((v) => v.f),
      cands,
      this.asked,
      m,
      (i) => this.voices[i].score,
    );
    if (!pair) {
      this.status = m ? "no new question yet: the search is still looking" : "every pair of the first voices has been asked";
      this.emit();
      return;
    }
    const [a, b] = Math.random() < 0.5 ? pair : [pair[1], pair[0]];
    this.status = "rendering the next question";
    this.emit();
    const [pa, pb] = await Promise.all([pool.send<{ samples: number[] }>(0, { type: "render", x: this.voices[a].x }), pool.send<{ samples: number[] }>(1, { type: "render", x: this.voices[b].x })]);
    const samples: [Float32Array, Float32Array] = [Float32Array.from(pa.samples), Float32Array.from(pb.samples)];
    const g = matchLoudness(samples, 48000);
    const st = m ? m.standard : standardOf(cands.map((i) => this.voices[i].f));
    const za = standardise(st, this.voices[a].f);
    const zb = standardise(st, this.voices[b].f);
    const apart = Math.sqrt(za.reduce((t, v, k) => t + (v - zb[k]) ** 2, 0) / za.length);
    this.question = { a, b, samples, gains: [g[0], g[1]], apart };
    this.status = m ? "searching while you listen" : "listen, then answer";
    this.emit();
  }

  /** Render the voice the model rates best, and the default beside it. */
  async renderFavourite(): Promise<void> {
    const pool = this.pool;
    if (!pool || !this.voices.length) return;
    const index = this.best;
    const ps = await Promise.all([index, 0].map((i, k) => pool.send<{ samples: number[] }>(k, { type: "render", x: this.voices[i].x })));
    const samples = ps.map((p) => Float32Array.from(p.samples));
    this.favourite = { index, samples, gains: matchLoudness(samples, 48000) };
    this.emit();
  }

  /** Every voice the search tries joins the archive; the search waits while there is no model. */
  private async search(pool: Pool): Promise<void> {
    while (!this.stopping) {
      if (!this.model) {
        await new Promise<void>((ok) => (this.wake = ok));
        this.wake = null;
        continue;
      }
      if (this.restart) {
        // start again from the best voice whenever the model changes: it is a different problem
        call("evolveStart", { sigma: SEARCH_SIGMA, pop: POP, seed: this.seed + this.generations, start: this.voices[this.best].x, free: this.searched });
        this.restart = false;
      }
      const xs = call<number[][]>("evolveAsk");
      // the first two workers render the questions; the search uses the rest when there are more
      const lanes = pool.size > 2 ? Array.from({ length: pool.size - 2 }, (_, i) => i + 2) : [0, 1];
      const feats = await this.features(pool, xs, lanes);
      if (this.restart || !this.model) continue;
      const m = this.model;
      const heard = this.heard();
      const d = reach(m, heard);
      const scores = xs.map((x, k) => {
        const f = feats[k];
        if (!f) return -1e9;
        const v: Voice = { x, f, dist2: this.dist2(x), origin: "search", score: 0 };
        v.score = objective(m, f, v.dist2, heard, d, this.weights);
        this.voices.push(v);
        return v.score;
      });
      call("evolveTell", { losses: scores.map((s) => -s) });
      this.generations++;
      if (!this.question) await this.ask(pool);
      this.emit();
    }
  }

  private async features(pool: Pool, xs: number[][], lanes?: number[]): Promise<(number[] | null)[]> {
    const ws = lanes ?? Array.from({ length: pool.size }, (_, i) => i);
    const chunks: number[][][] = ws.map(() => []);
    xs.forEach((x, i) => chunks[i % ws.length].push(x));
    const parts = await Promise.all(chunks.map((c, k) => (c.length ? pool.send<(number[] | null)[]>(ws[k], { type: "features", xs: c }) : Promise.resolve([]))));
    const at = new Array<number>(ws.length).fill(0);
    return xs.map((_, i) => parts[i % ws.length][at[i % ws.length]++]);
  }

  /** The model's view of a voice: reward, its spread over the ensemble. */
  rate(i: number): { r: number; spread: number } | null {
    if (!this.model) return null;
    const { r, spread } = reward(this.model, this.voices[i].f);
    return { r, spread };
  }
}

const pairKey = (i: number, j: number) => (i < j ? `${i}:${j}` : `${j}:${i}`);

/** The saved answers: the dev server's copy, else the browser's, else none. */
async function loadAnswers(): Promise<Answer[]> {
  try {
    const r = await fetch(`/voiceref/saved/${FILE}`);
    if (r.ok) return ((await r.json()) as { answers: Answer[] }).answers ?? [];
  } catch {
    /* no dev server */
  }
  try {
    const s = localStorage.getItem(STORE);
    if (s) return (JSON.parse(s) as { answers: Answer[] }).answers ?? [];
  } catch {
    /* storage blocked */
  }
  return [];
}

async function saveAnswers(answers: Answer[]): Promise<void> {
  const body = JSON.stringify({ version: 1, answers }, null, 1);
  try {
    localStorage.setItem(STORE, body);
  } catch {
    /* storage blocked: the server copy still counts */
  }
  try {
    await fetch(`/voiceref/save/${FILE}`, { method: "POST", body });
  } catch {
    /* no dev server: the browser copy still counts */
  }
}
