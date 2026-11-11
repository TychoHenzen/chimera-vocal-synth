/**
 * Deletes cargo's incremental caches that nothing has compiled into for a week.
 *
 * Cargo keeps one incremental folder per build unit, named by a hash of the unit's settings
 * (profile, features, compiler version). When those settings change, the old folder is never
 * reused or removed. Each is 50-150 MB here, and they grew `target/debug` to 4.3 GB in a few
 * days. Turning incremental off instead made a test rebuild take 58 s rather than 9 s.
 *
 * Runs at the start of `bun run test`. Deleting a folder that is still current costs only one
 * slower rebuild of that unit.
 */
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const MAX_AGE_DAYS = 7;

/** Incremental folders under `root`'s cargo target dirs, older than `days` at `now` (ms). */
export function staleIncremental(root: string, now: number, days = MAX_AGE_DAYS): string[] {
  const out: string[] = [];
  const cutoff = now - days * 86_400_000;
  for (const target of ["target", "target-dev"]) {
    const t = join(root, target);
    if (!existsSync(t)) continue;
    // profile dirs (debug, release) and per-triple dirs (wasm32-unknown-unknown/release)
    const profiles = readdirSync(t, { withFileTypes: true }).filter((d) => d.isDirectory());
    const candidates = profiles.flatMap((p) => {
      const dir = join(t, p.name);
      const nested = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== "incremental");
      return [join(dir, "incremental"), ...nested.map((n) => join(dir, n.name, "incremental"))];
    });
    for (const inc of candidates) {
      if (!existsSync(inc)) continue;
      for (const unit of readdirSync(inc, { withFileTypes: true })) {
        if (!unit.isDirectory()) continue;
        const path = join(inc, unit.name);
        // a compile writes a new session folder inside the unit folder, which updates its time
        if (statSync(path).mtimeMs < cutoff) out.push(path);
      }
    }
  }
  return out;
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const stale = staleIncremental(root, Date.now());
  for (const p of stale) rmSync(p, { recursive: true, force: true });
  if (stale.length) console.log(`prune-target: removed ${stale.length} incremental cache folders unused for ${MAX_AGE_DAYS} days`);
}
