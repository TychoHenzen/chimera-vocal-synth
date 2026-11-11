/** Canvas drawing for the Evolve mode: line charts, the gene map and the spectrogram strips. */
import type { NoteValues } from "./runner.ts";
import type { GenRecord } from "./types.ts";

export const INK = { blue: "#4fb6f2", amber: "#ffb340", green: "#5be381", red: "#ff5d40", pink: "#ff73cf", white: "#eef6f8", dim: "#3487c4", grid: "#133954" };

/** Size a canvas to its CSS box at the device's pixel ratio and return a context in CSS pixels. */
export function prepare(c: HTMLCanvasElement): { g: CanvasRenderingContext2D; w: number; h: number } | null {
  const r = window.devicePixelRatio || 1;
  const w = c.clientWidth;
  const h = c.clientHeight;
  if (w < 2 || h < 2) return null;
  if (c.width !== Math.round(w * r) || c.height !== Math.round(h * r)) {
    c.width = Math.round(w * r);
    c.height = Math.round(h * r);
  }
  const g = c.getContext("2d")!;
  g.setTransform(r, 0, 0, r, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h };
}

export interface Series {
  label: string;
  color: string;
  pts: [number, number][];
}

interface SeriesOpts {
  logY?: boolean;
  zeroY?: boolean;
  /** x values where a sweep's window changes */
  marks?: number[];
}

/** A chart's data range and its mapping to the canvas (margins in CSS pixels). */
interface Frame {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  px: (x: number) => number;
  py: (y: number) => number;
  /** the y axis's ends as plotted (log for a log axis) */
  a: number;
  b: number;
}

const SERIES_MARGIN = { l: 44, r: 8, t: 8, b: 20 };

function seriesFrame(all: [number, number][], w: number, h: number, opts: SeriesOpts): Frame {
  const m = SERIES_MARGIN;
  const x0 = Math.min(...all.map((q) => q[0]));
  let x1 = Math.max(...all.map((q) => q[0]));
  if (x0 === x1) x1 = x0 + 1;
  let y0 = Math.min(...all.map((q) => q[1]));
  let y1 = Math.max(...all.map((q) => q[1]));
  if (opts.zeroY) y0 = Math.min(0, y0);
  if (y0 === y1) {
    y0 -= 1;
    y1 += 1;
  }
  const f = (v: number) => (opts.logY ? Math.log(Math.max(v, 1e-9)) : v);
  const [a, b] = [f(y0), f(y1)];
  const px = (x: number) => m.l + ((x - x0) / (x1 - x0)) * (w - m.l - m.r);
  const py = (y: number) => h - m.b - ((f(y) - a) / (b - a || 1)) * (h - m.t - m.b);
  return { x0, x1, y0, y1, px, py, a, b };
}

/** Grid lines with y labels, x labels, and dashed lines at the marks. */
function drawAxes(g: CanvasRenderingContext2D, w: number, h: number, fr: Frame, opts: SeriesOpts): void {
  const m = SERIES_MARGIN;
  const { x0, x1, y0, y1, px, py, a, b } = fr;
  g.font = "11px system-ui, sans-serif";
  g.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const v = opts.logY ? Math.exp(a + ((b - a) * i) / 4) : y0 + ((y1 - y0) * i) / 4;
    const y = py(v);
    g.strokeStyle = INK.grid;
    g.beginPath();
    g.moveTo(m.l, y);
    g.lineTo(w - m.r, y);
    g.stroke();
    g.fillStyle = INK.dim;
    g.fillText(v.toFixed(Math.abs(v) < 10 ? 2 : 0), 2, y + 4);
  }
  for (let i = 0; i <= 4; i++) {
    const v = x0 + ((x1 - x0) * i) / 4;
    g.fillStyle = INK.dim;
    g.fillText(String(Math.round(v * 10) / 10), px(v) - 8, h - 5);
  }
  for (const x of opts.marks ?? []) {
    if (x < x0 || x > x1) continue;
    g.strokeStyle = INK.dim;
    g.setLineDash([3, 3]);
    g.beginPath();
    g.moveTo(px(x), m.t);
    g.lineTo(px(x), h - m.b);
    g.stroke();
    g.setLineDash([]);
  }
}

/** One series as a line, skipping points the axis cannot show. */
function strokeSeries(g: CanvasRenderingContext2D, s: Series, fr: Frame, logY: boolean): void {
  g.strokeStyle = s.color;
  g.lineWidth = 1.6;
  g.beginPath();
  let first = true;
  for (const q of s.pts) {
    if (!Number.isFinite(q[1]) || (logY && q[1] <= 0)) continue;
    if (first) g.moveTo(fr.px(q[0]), fr.py(q[1]));
    else g.lineTo(fr.px(q[0]), fr.py(q[1]));
    first = false;
  }
  g.stroke();
}

export function drawSeries(c: HTMLCanvasElement, series: Series[], opts: SeriesOpts = {}): void {
  const p = prepare(c);
  if (!p) return;
  const { g, w, h } = p;
  const all = series.flatMap((s) => s.pts).filter((q) => Number.isFinite(q[1]) && (!opts.logY || q[1] > 0));
  if (!all.length) return;
  const fr = seriesFrame(all, w, h, opts);
  drawAxes(g, w, h, fr, opts);
  for (const s of series) strokeSeries(g, s, fr, !!opts.logY);
}

/** Every gene of the best genome over the generations: rows are genes, columns generations. */
export function drawGenes(c: HTMLCanvasElement, history: GenRecord[], names: string[]): void {
  const p = prepare(c);
  if (!p || !history.length) return;
  const { g, w, h } = p;
  const left = 150;
  const cw = Math.max(1, (w - left - 4) / history.length);
  const rh = (h - 4) / names.length;
  history.forEach((rec, j) => {
    rec.x.forEach((v, i) => {
      const t = Math.min(1, Math.max(0, v));
      g.fillStyle = `hsl(${210 - 200 * t} 70% ${22 + 38 * Math.abs(t - 0.5) * 2 * 0.5 + 12 * t}%)`;
      g.fillRect(left + j * cw, 2 + i * rh, Math.ceil(cw), Math.max(1, Math.ceil(rh) - 1));
    });
  });
  g.fillStyle = INK.dim;
  g.font = `${Math.min(10, Math.max(6, rh))}px system-ui, sans-serif`;
  names.forEach((nm, i) => g.fillText(nm, 2, 2 + i * rh + rh * 0.8));
}

export interface NoteLook {
  start: number;
  end: number;
  midi: number;
  text: string;
  /** "pending" (no window reached it), "active" (in the window being evolved) or "done" */
  state: "pending" | "active" | "done";
  /** the note's evolved genes, when a window has reached it */
  genes: NoteValues | null;
}

/**
 * The song's notes as a piano roll: each note's written place (outline) and where its genes have
 * moved it (filled: timing shift and length, pitch in cents, brightness by level), its syllable
 * below, the window being evolved shaded, and a playhead (song seconds) while the section plays.
 */
export function drawNotes(c: HTMLCanvasElement, notes: NoteLook[], win: [number, number] | null, playhead: number | null): void {
  const p = prepare(c);
  if (!p || !notes.length) return;
  const { g, w, h } = p;
  const roll = rollOf(notes, w, h);
  drawKeys(g, roll, w);
  if (win) drawWindow(g, roll, notes, win, h);
  g.font = "10px system-ui, sans-serif";
  g.textAlign = "center";
  notes.forEach((n, k) => drawNote(g, roll, n, k, h));
  g.textAlign = "start";
  if (playhead !== null && playhead >= roll.t0 && playhead <= roll.t1) {
    g.strokeStyle = INK.pink;
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(roll.px(playhead), ROLL_MARGIN.t);
    g.lineTo(roll.px(playhead), h - ROLL_MARGIN.b);
    g.stroke();
  }
}

const ROLL_MARGIN = { l: 8, r: 8, t: 10, b: 34 };

/** The piano roll's time and pitch ranges and its mapping to the canvas. */
interface Roll {
  t0: number;
  t1: number;
  lo: number;
  hi: number;
  px: (t: number) => number;
  py: (midi: number) => number;
  /** a note bar's height */
  lane: number;
}

function rollOf(notes: NoteLook[], w: number, h: number): Roll {
  const m = ROLL_MARGIN;
  const t0 = notes[0].start - 0.3;
  const t1 = notes[notes.length - 1].end + 0.3;
  const lo = Math.min(...notes.map((n) => n.midi)) - 1.5;
  const hi = Math.max(...notes.map((n) => n.midi)) + 1.5;
  const px = (t: number) => m.l + ((t - t0) / (t1 - t0)) * (w - m.l - m.r);
  const py = (midi: number) => m.t + ((hi - midi) / (hi - lo)) * (h - m.t - m.b);
  const lane = Math.max(3, ((h - m.t - m.b) / (hi - lo)) * 0.8);
  return { t0, t1, lo, hi, px, py, lane };
}

/** A line per semitone, brighter at each C. */
function drawKeys(g: CanvasRenderingContext2D, roll: Roll, w: number): void {
  for (let k = Math.ceil(roll.lo); k <= roll.hi; k++) {
    g.strokeStyle = k % 12 === 0 ? INK.dim : INK.grid;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(ROLL_MARGIN.l, roll.py(k));
    g.lineTo(w - ROLL_MARGIN.r, roll.py(k));
    g.stroke();
  }
}

/** The window being evolved, shaded over the clip the engine cuts around its notes. */
function drawWindow(g: CanvasRenderingContext2D, roll: Roll, notes: NoteLook[], win: [number, number], h: number): void {
  const m = ROLL_MARGIN;
  const a = roll.px(notes[win[0]].start - 0.4);
  const b = roll.px(notes[win[1]].end + 0.5);
  g.fillStyle = "rgba(255, 179, 64, 0.08)";
  g.fillRect(a, m.t, b - a, h - m.t - m.b);
  g.strokeStyle = INK.amber;
  g.strokeRect(a + 0.5, m.t + 0.5, b - a - 1, h - m.t - m.b - 1);
}

/** Note k: its written place, where its genes moved it, and its syllable below. */
function drawNote(g: CanvasRenderingContext2D, roll: Roll, n: NoteLook, k: number, h: number): void {
  const { px, py, lane } = roll;
  const y = py(n.midi);
  g.strokeStyle = n.state === "pending" ? INK.grid : INK.dim;
  g.lineWidth = 1;
  g.strokeRect(px(n.start) + 0.5, y - lane / 2, Math.max(1, px(n.end) - px(n.start) - 1), lane);
  const gn = n.genes;
  if (gn) {
    const s = n.start + gn.shift;
    const e = Math.max(s + 0.05, n.end + gn.shift + gn.dur);
    const yy = py(n.midi + gn.cents / 100);
    // level -15..+15 dB as 0.25..1 opacity
    g.globalAlpha = Math.max(0.25, Math.min(1, 0.625 + gn.level / 40));
    g.fillStyle = n.state === "active" ? INK.amber : INK.blue;
    g.fillRect(px(s), yy - lane / 2 + 1, Math.max(1, px(e) - px(s) - 1), lane - 2);
    g.globalAlpha = 1;
  }
  // syllables alternate rows so short notes don't overprint
  const ty = h - ROLL_MARGIN.b + 13 + (k % 2) * 12;
  const label = gn?.vowel ? `${n.text}>${gn.vowel}` : n.text;
  g.fillStyle = n.state === "active" ? INK.amber : n.state === "done" ? INK.white : INK.dim;
  g.fillText(label, px((n.start + n.end) / 2), ty);
}

const colormap = (t: number): [number, number, number] => [
  255 * Math.min(1, Math.max(0, 1.5 * t - 0.2)),
  255 * Math.min(1, Math.max(0, t * t * 1.2)),
  255 * Math.min(1, Math.max(0, 0.9 - 1.2 * t + 0.8 * t * t)),
];

/** Recording (top), render (middle) and their difference (bottom): log-mel, time to the right. */
export function drawSpectro(c: HTMLCanvasElement, ref: number[], sim: number[], bands: number): void {
  const p = prepare(c);
  if (!p || !ref.length) return;
  const { g, w, h } = p;
  const frames = Math.floor(ref.length / bands);
  const ph = Math.floor((h - 8) / 3);
  const paint = (y0: number, f: (i: number) => [number, number, number]) => {
    const off = document.createElement("canvas");
    off.width = frames;
    off.height = bands;
    const og = off.getContext("2d")!;
    const im = og.createImageData(frames, bands);
    for (let fr = 0; fr < frames; fr++)
      for (let b = 0; b < bands; b++) {
        const col = f(fr * bands + b);
        const o = ((bands - 1 - b) * frames + fr) * 4;
        im.data[o] = col[0];
        im.data[o + 1] = col[1];
        im.data[o + 2] = col[2];
        im.data[o + 3] = 255;
      }
    og.putImageData(im, 0, 0);
    g.imageSmoothingEnabled = true;
    g.drawImage(off, 0, y0, w, ph);
  };
  paint(0, (i) => colormap(ref[i] / 255));
  paint(ph + 4, (i) => colormap(sim[i] / 255));
  paint(2 * ph + 8, (i) => {
    const d = (sim[i] - ref[i]) / 255;
    return d > 0 ? [255 * Math.min(1, d * 3), 60, 60] : [60, 60, 255 * Math.min(1, -d * 3)];
  });
}
