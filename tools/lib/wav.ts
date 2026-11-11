import { readFileSync } from "node:fs";

export function readWav(path: string): { sampleRate: number; channels: Float32Array[] } {
  const buf = readFileSync(path);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV");
  let off = 12;
  let fmt: { ch: number; sr: number; bits: number; format: number } | null = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      fmt = { format: buf.readUInt16LE(body), ch: buf.readUInt16LE(body + 2), sr: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === "data" && fmt) {
      const bps = fmt.bits / 8;
      const frames = Math.floor(size / (bps * fmt.ch));
      const channels = Array.from({ length: fmt.ch }, () => new Float32Array(frames));
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < fmt.ch; c++) {
          const p = body + (i * fmt.ch + c) * bps;
          let v = 0;
          if (fmt.format === 3 && fmt.bits === 32) v = buf.readFloatLE(p);
          else if (fmt.bits === 16) v = buf.readInt16LE(p) / 32768;
          else if (fmt.bits === 24) v = (buf.readIntLE(p, 3)) / 8388608;
          else if (fmt.bits === 32) v = buf.readInt32LE(p) / 2147483648;
          channels[c][i] = v;
        }
      }
      return { sampleRate: fmt.sr, channels };
    }
    off = body + size + (size & 1);
  }
  throw new Error("no data chunk");
}
