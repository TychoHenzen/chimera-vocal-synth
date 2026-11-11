/**
 * Two (or more) clips looping together from the same instant; one is heard at a time and
 * switching is instant, so the listener compares the same moment of each voice. Separate players,
 * one after the other, made comparisons slow and unreliable.
 */
let looper: { ctx: AudioContext; gains: GainNode[]; srcs: AudioBufferSourceNode[] } | null = null;

export function isLooping(): boolean {
  return looper !== null;
}

export function stopLoop(): void {
  if (!looper) return;
  for (const s of looper.srcs) {
    try {
      s.stop();
    } catch {
      /* already stopped */
    }
  }
  void looper.ctx.close();
  looper = null;
}

export function startLoop(clips: Float32Array[], gains: number[], on: number): void {
  stopLoop();
  const ctx = new AudioContext({ sampleRate: 48000 });
  const len = Math.max(...clips.map((c) => c.length));
  const at = ctx.currentTime + 0.05;
  const nodes = clips.map((c, k) => {
    const buf = ctx.createBuffer(1, len, 48000);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < c.length; i++) ch[i] = c[i] * gains[k];
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const g = ctx.createGain();
    g.gain.value = k === on ? 1 : 0;
    src.connect(g).connect(ctx.destination);
    src.start(at);
    return { src, g };
  });
  looper = { ctx, gains: nodes.map((n) => n.g), srcs: nodes.map((n) => n.src) };
}

/** Hear clip `on` of the loop; a 10 ms crossfade keeps the switch from clicking. */
export function switchLoop(on: number): void {
  if (!looper) return;
  const t = looper.ctx.currentTime;
  looper.gains.forEach((g, k) => {
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(g.gain.value, t);
    g.gain.linearRampToValueAtTime(k === on ? 1 : 0, t + 0.01);
  });
}
