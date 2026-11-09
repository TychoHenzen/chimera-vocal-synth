import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

/** Dev/preview only: hands the CSD songs in voiceRef/ (not committed) to the Evolve page. */
function voiceRef(): Plugin {
  const dir = path.resolve(__dirname, "voiceRef/CSD/english");
  const handler = (req: { url?: string }, res: import("node:http").ServerResponse, next: () => void) => {
    const url = (req.url ?? "").split("?")[0];
    if (!url.startsWith("/voiceref/")) return next();
    if (url === "/voiceref/list") {
      const wavs = fs.existsSync(path.join(dir, "wav")) ? fs.readdirSync(path.join(dir, "wav")) : [];
      const songs = wavs.filter((f) => f.endsWith(".wav") && fs.existsSync(path.join(dir, "csv", f.replace(/\.wav$/, ".csv")))).map((f) => f.replace(/\.wav$/, ""));
      res.setHeader("content-type", "application/json");
      return void res.end(JSON.stringify({ songs }));
    }
    const m = /^\/voiceref\/csd\/([\w-]+)\.(wav|csv)$/.exec(url);
    const file = m && path.join(dir, m[2], `${m[1]}.${m[2]}`);
    if (!file || !fs.existsSync(file)) {
      res.statusCode = 404;
      return void res.end("not found");
    }
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
