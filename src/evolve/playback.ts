/** Evolve's browser audio: decode a recording, play one clip at a time, and keep a render. */

export async function decodeAudio(buf: ArrayBuffer): Promise<{ samples: Float32Array; rate: number }> {
  const ctx = new AudioContext({ sampleRate: 48000 });
  try {
    const a = await ctx.decodeAudioData(buf.slice(0));
    const out = new Float32Array(a.length);
    for (let c = 0; c < a.numberOfChannels; c++) {
      const ch = a.getChannelData(c);
      for (let i = 0; i < out.length; i++) out[i] += ch[i] / a.numberOfChannels;
    }
    return { samples: out, rate: a.sampleRate };
  } finally {
    void ctx.close();
  }
}

let player: { ctx: AudioContext; src: AudioBufferSourceNode; at: number } | null = null;

export function stopPlaying(): void {
  if (!player) return;
  try {
    player.src.stop();
  } catch {
    /* already ended */
  }
  void player.ctx.close();
  player = null;
}

/** Seconds into the clip that is playing, or null. */
export function playingAt(): number | null {
  return player ? player.ctx.currentTime - player.at : null;
}

export function play(samples: ArrayLike<number>, rate: number, onEnd: () => void): void {
  stopPlaying();
  const ctx = new AudioContext({ sampleRate: rate });
  const buf = ctx.createBuffer(1, samples.length, rate);
  const ch = buf.getChannelData(0);
  let peak = 1e-9;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  // levels are kept (volume is part of the score); only scaled down if it would clip
  const k = Math.min(1, 0.95 / peak);
  for (let i = 0; i < samples.length; i++) ch[i] = samples[i] * k;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.onended = () => {
    if (player?.src === src) stopPlaying();
    onEnd();
  };
  src.start();
  player = { ctx, src, at: ctx.currentTime };
}

export function download(name: string, data: string | Blob): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(typeof data === "string" ? new Blob([data], { type: "application/json" }) : data);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** 16-bit mono WAV, peak-normalised only if it would clip (as it plays). */
export function wavBlob(samples: ArrayLike<number>, rate: number): Blob {
  let peak = 1e-9;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  const k = Math.min(1, 0.95 / peak);
  const buf = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const str = (o: number, t: string) => [...t].forEach((ch, i) => buf.setUint8(o + i, ch.charCodeAt(0)));
  str(0, "RIFF");
  buf.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVEfmt ");
  buf.setUint32(16, 16, true);
  buf.setUint16(20, 1, true);
  buf.setUint16(22, 1, true);
  buf.setUint32(24, rate, true);
  buf.setUint32(28, rate * 2, true);
  buf.setUint16(32, 2, true);
  buf.setUint16(34, 16, true);
  str(36, "data");
  buf.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    buf.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(samples[i] * k * 32767))), true);
  }
  return new Blob([buf.buffer], { type: "audio/wav" });
}

/** Keep a render: the dev/preview server writes it to out/evolve/; elsewhere the browser downloads it. */
export async function saveWav(name: string, blob: Blob, say: (m: string) => void): Promise<void> {
  try {
    const r = await fetch(`/voiceref/save/${name}`, { method: "POST", body: blob });
    if (r.ok) return say(`saved to ${await r.text()}`);
  } catch {
    /* no dev server: download instead */
  }
  download(name, blob);
}
