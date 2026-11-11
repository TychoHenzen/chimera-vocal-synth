/**
 * The target folder grew to 4.3 GB of cargo incremental caches whose settings hash had gone
 * stale. The pruner must find those and leave the ones a build still writes to.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staleIncremental } from "../tools/prune-target.ts";

const root = mkdtempSync(join(tmpdir(), "prune-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("only incremental folders older than a week are stale", () => {
  const now = Date.UTC(2026, 10, 11);
  const day = 86_400_000;
  const make = (rel: string, age: number) => {
    const p = join(root, rel);
    mkdirSync(p, { recursive: true });
    const t = new Date(now - age * day);
    utimesSync(p, t, t);
    return p;
  };
  const old = make("target/debug/incremental/chimera-old", 9);
  const fresh = make("target/debug/incremental/chimera-new", 1);
  const wasmOld = make("target/wasm32-unknown-unknown/release/incremental/chimera_wasm-old", 30);
  const devOld = make("target-dev/release/incremental/chimera-x", 8);
  // deps are never touched, however old
  make("target/debug/deps/old", 40);
  const stale = staleIncremental(root, now).sort();
  expect(stale).toEqual([old, devOld, wasmOld].sort());
  expect(stale).not.toContain(fresh);
});
