import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import { lyricsOf, vocalsetToCsd } from "./tools/vocalset-notes.ts";

/**
 * Dev/preview only: hands the recordings in voiceRef/ (not committed) to the Evolve page: the CSD
 * songs, and the VocalSet excerpts (Italian, Latin, and the English Row your boat), their segment
 * tables turned into CSD notes.
 */
function voiceRef(): Plugin {
  const root = path.resolve(import.meta.dirname, "voiceRef");
  const dir = path.join(root, "CSD/english");
  let cached: Map<string, { wav: string; csv: string }> | null = null;
  /** VocalSet key -> wav and extended segment table (with lyrics), from voiceRef/vocalset-index.json */
  const vocalset = (): Map<string, { wav: string; csv: string }> => {
    if (cached) return cached;
    const out = (cached = new Map<string, { wav: string; csv: string }>());
    const index = path.join(root, "vocalset-index.json");
    if (!fs.existsSync(index)) return out;
    const { entries } = JSON.parse(fs.readFileSync(index, "utf8")) as { entries: { key: string; wav: string; context: string; annotation: string | null }[] };
    for (const e of entries) {
      if (e.context !== "excerpts" || !e.annotation) continue;
      // the "raw" tables have no lyrics; the "extended" ones beside them do
      const csv = path.join(root, e.annotation.replace("raw 1/csv/", "extended 1/without file header/"));
      const wav = path.join(root, "FULL", e.wav);
      if (/^[\w-]+$/.test(e.key) && fs.existsSync(csv) && fs.existsSync(wav)) out.set(e.key, { wav, csv });
    }
    return out;
  };
  const handler = (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, next: () => void) => {
    const url = (req.url ?? "").split("?")[0];
    if (!url.startsWith("/voiceref/")) return next();
    if (url === "/voiceref/list") {
      const wavs = fs.existsSync(path.join(dir, "wav")) ? fs.readdirSync(path.join(dir, "wav")) : [];
      const songs = wavs.filter((f) => f.endsWith(".wav") && fs.existsSync(path.join(dir, "csv", f.replace(/\.wav$/, ".csv")))).map((f) => `csd/${f.replace(/\.wav$/, "")}`);
      songs.push(...[...vocalset().keys()].sort().map((k) => `vocalset/${k}`));
      res.setHeader("content-type", "application/json");
      return void res.end(JSON.stringify({ songs }));
    }
    const notFound = () => {
      res.statusCode = 404;
      res.end("not found");
    };
    // a render the page (or an agent driving it) wants kept: written to out/evolve/ (gitignored)
    const save = /^\/voiceref\/save\/([\w-]+\.wav)$/.exec(url);
    if (save && req.method === "POST") {
      const parts: Buffer[] = [];
      let size = 0;
      req.on("data", (b: Buffer) => {
        size += b.length;
        if (size <= 64 << 20) parts.push(b);
      });
      req.on("end", () => {
        if (size > 64 << 20) {
          res.statusCode = 413;
          return void res.end("too large");
        }
        const out = path.resolve(import.meta.dirname, "out/evolve");
        fs.mkdirSync(out, { recursive: true });
        fs.writeFileSync(path.join(out, save[1]), Buffer.concat(parts));
        res.end(path.join("out/evolve", save[1]));
      });
      return;
    }
    const v = /^\/voiceref\/vocalset\/([\w-]+)\.(wav|csv)$/.exec(url);
    if (v) {
      const e = vocalset().get(v[1]);
      if (!e) return notFound();
      if (v[2] === "csv") {
        res.setHeader("content-type", "text/csv");
        return void res.end(vocalsetToCsd(fs.readFileSync(e.csv, "utf8"), lyricsOf(v[1])));
      }
      res.setHeader("content-type", "audio/wav");
      return void fs.createReadStream(e.wav).pipe(res);
    }
    const m = /^\/voiceref\/csd\/([\w-]+)\.(wav|csv)$/.exec(url);
    const file = m && path.join(dir, m[2], `${m[1]}.${m[2]}`);
    if (!m || !file || !fs.existsSync(file)) return notFound();
    res.setHeader("content-type", m[2] === "wav" ? "audio/wav" : "text/csv");
    fs.createReadStream(file).pipe(res);
  };
  return {
    name: "voiceref",
    configureServer: (s) => void s.middlewares.use(handler),
    configurePreviewServer: (s) => void s.middlewares.use(handler),
  };
}

export default defineConfig({
  plugins: [react(), voiceRef()],
  worker: { format: "es" },
  build: { target: "es2022", sourcemap: true },
  server: { host: "127.0.0.1", port: 5317, strictPort: true, allowedHosts: true },
  preview: { host: "127.0.0.1", port: 5318, strictPort: true, allowedHosts: true },
});
