/**
 * quality-guard's structural scan, set up for this repo: `bun run quality [--top=N | --units]`.
 * Finds the newest installed quality-scan.mjs (the plugin is installed per user, not vendored),
 * prints the readable report, and with --units writes .quality/units.json for the refactor skill.
 * The rules and how this repo answers them are in AGENTS.md ("Quality scan").
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const base = join(homedir(), ".claude/plugins/cache/dod-guard/quality-guard");
const versions = existsSync(base)
  ? readdirSync(base).filter((v) => existsSync(join(base, v, "skills/quality-refactor/scripts/quality-scan.mjs")))
  : [];
if (!versions.length) {
  console.error(`quality: no quality-guard install under ${base} (install the dod-guard quality-guard plugin)`);
  process.exit(2);
}
const newest = versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1)!;
const scanner = join(base, newest, "skills/quality-refactor/scripts/quality-scan.mjs");

// ASSUMPTION: docs/mockups is the frozen design reference (approved HTML and the generator that
// drew it, see docs/ui-redesign.md), not product code, so it is not held to these rules.
const flags = ["--root=.", "--exclude=docs/mockups", "--test-path=tests", "--test-path=crates/chimera/tests"];

const units = process.argv.includes("--units");
const rest = process.argv.slice(2).filter((a) => a !== "--units");
const args = [scanner, ".", ...flags, ...(units ? ["--format=units"] : rest.length ? rest : ["--top=20"])];
const run = Bun.spawnSync(["node", ...args], { stdout: "pipe", stderr: "inherit" });
const out = run.stdout.toString();
if (units) {
  mkdirSync(".quality", { recursive: true });
  writeFileSync(".quality/units.json", out);
  console.log(`quality: wrote .quality/units.json (quality-guard ${newest})`);
} else process.stdout.write(out);
process.exit(run.exitCode ?? 1);
