/** Canvas drawing for the Evolve mode: line charts, the gene map and the spectrogram strips. */
import type { GenRecord } from "./runner.ts";

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

export function drawSeries(c: HTMLCanvasElement, series: Series[], opts: { logY?: boolean; zeroY?: boolean } = {}): void {
  const p = prepare(c);
  if (!p) return;
  const { g, w, h } = p;
  const all = series.flatMap((s) => s.pts).filter((q) => Number.isFinite(q[1]) && (!opts.logY || q[1] > 0));
  if (!all.length) return;
  const m = { l: 44, r: 8, t: 8, b: 20 };
  let x0 = Math.min(...all.map((q) => q[0]));
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
  for (const s of series) {
    g.strokeStyle = s.color;
    g.lineWidth = 1.6;
    g.beginPath();
    let first = true;
    for (const q of s.pts) {
      if (!Number.isFinite(q[1]) || (opts.logY && q[1] <= 0)) continue;
      if (first) g.moveTo(px(q[0]), py(q[1]));
      else g.lineTo(px(q[0]), py(q[1]));
      first = false;
    }
    g.stroke();
  }
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
