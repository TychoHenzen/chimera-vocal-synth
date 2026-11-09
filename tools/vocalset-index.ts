#!/usr/bin/env bun
/**
 * Index VocalSet (voiceRef/FULL) and join each recording to its Annotated VocalSet entry.
 *
 * Writes voiceRef/vocalset-index.json (gitignored, like the data) and prints the coverage table.
 * See docs/vocalset.md for how the two datasets fit together.
 *
 * usage: bun tools/vocalset-index.ts [voiceRef dir]
 */
import { readdirSync, readFileSync, openSync, readSync, closeSync, writeFileSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = process.argv[2] ?? join(import.meta.dir, "..", "voiceRef");
const full = join(root, "FULL");
const ann = join(root, "Annotated VocalSet");

/** Annotation frames are 512 samples at 44.1 kHz. */
const HOP = 512 / 44100;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Seconds of audio, from the RIFF header (fmt rate, data size). */
function wavSeconds(path: string): number {
  const fd = openSync(path, "r");
  const buf = Buffer.alloc(4096);
  readSync(fd, buf, 0, buf.length, 0);
  closeSync(fd);
  let rate = 0;
  let align = 0;
  for (let o = 12; o + 8 <= buf.length; ) {
    const id = buf.toString("ascii", o, o + 4);
    const size = buf.readUInt32LE(o + 4);
    if (id === "fmt ") {
      rate = buf.readUInt32LE(o + 12);
      align = buf.readUInt16LE(o + 20);
    } else if (id === "data") {
      // a data chunk sized past the file (streamed writers) falls back to the file size
      const bytes = Math.min(size, statSync(path).size - o - 8);
      return rate && align ? bytes / align / rate : 0;
    }
    o += 8 + size + (size & 1);
  }
  return 0;
}

function csvRows(path: string): string[][] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => l.split(",").map((c) => c.trim()));
}

const TECHNIQUE_FIX: Record<string, string> = { vibrado: "vibrato" };

/**
 * The name the annotations use for a recording. Most wav names already are that name. A few wavs
 * lost the singer prefix, carry a copy suffix "(1)", or have a typo ("sow_forte"); the singer then
 * comes from the folder, which is the reliable source (male8/ holds a file named m9_caro_vibrato).
 */
function joinKey(singer: string, file: string): string {
  let n = file.replace(/\.wav$/i, "").replace(/\(1\)$/, "").replace("_sow_forte", "_slow_forte");
  if (!/^[fm]\d+_/.test(n)) n = `${singer}_${n}`;
  return n.replace(/^[fm]\d+_/, `${singer}_`);
}

// raw 1 holds one frame track per annotated recording: time, F0 (0 = unvoiced), amplitude, onset, offset, transition
const rawDir = join(ann, "raw 1", "csv");
const rawByKey = new Map<string, string>();
for (const p of walk(rawDir)) if (p.endsWith(".csv")) rawByKey.set(p.split(sep).pop()!.slice(0, -4), p);

// one row per segment; the per-file columns repeat on every row
const labels = new Map<string, { technique: string; musicType: string; sounds: number; transitions: number }>();
{
  const rows = csvRows(join(ann, "extended 1", "all files.csv"));
  const h = rows[0];
  const col = (name: string) => h.indexOf(name);
  for (const r of rows.slice(1)) {
    const key = r[col("File Name")];
    const e = labels.get(key) ?? { technique: r[col("Technique")], musicType: r[col("Music Type")], sounds: 0, transitions: 0 };
    if (r[col("Type")] === "Sound") e.sounds++;
    if (r[col("Type")] === "Transition") e.transitions++;
    labels.set(key, e);
  }
}

function medianF0(csvPath: string): number | null {
  const f0 = csvRows(csvPath)
    .slice(1)
    .map((r) => Number(r[1]))
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  return f0.length ? Math.round(f0[f0.length >> 1] * 10) / 10 : null;
}

type Entry = {
  wav: string;
  singer: string;
  sex: "female" | "male";
  context: string;
  technique: string;
  vowel: string | null;
  seconds: number;
  key: string;
  annotation: string | null;
  label: string | null;
  musicType: string | null;
  notes: number | null;
  f0Median: number | null;
};

const entries: Entry[] = [];
const seenKeys = new Map<string, string>();
const problems: string[] = [];
for (const p of walk(full)) {
  if (!/\.wav$/i.test(p)) continue;
  const rel = relative(full, p).split(sep);
  const [folder, context, techFolder] = rel;
  const sex = folder.startsWith("female") ? "female" : "male";
  const singer = (sex === "female" ? "f" : "m") + folder.replace(/^(fe)?male/, "");
  const file = rel[rel.length - 1];
  // three female2 "(1)" files are byte-identical copies of the file next to them
  if (/\(1\)\.wav$/i.test(file) && existsSync(p.replace(/\(1\)(\.wav)$/i, "$1"))) continue;
  const key = joinKey(singer, file);
  if (seenKeys.has(key)) problems.push(`two wavs share the key ${key}: ${seenKeys.get(key)} and ${rel.join("/")}`);
  seenKeys.set(key, rel.join("/"));
  const raw = rawByKey.get(key) ?? null;
  const lab = labels.get(key) ?? null;
  entries.push({
    wav: rel.join("/"),
    singer,
    sex,
    context,
    technique: TECHNIQUE_FIX[techFolder] ?? techFolder,
    vowel: key.match(/_([aeiou])$/)?.[1] ?? null,
    seconds: Math.round(wavSeconds(p) * 1000) / 1000,
    key,
    annotation: raw ? relative(root, raw).split(sep).join("/") : null,
    label: lab?.technique ?? null,
    musicType: lab?.musicType ?? null,
    notes: lab ? lab.sounds : null,
    f0Median: raw ? medianF0(raw) : null,
  });
}
entries.sort((a, b) => a.wav.localeCompare(b.wav));
const orphans = [...rawByKey.keys()].filter((k) => !seenKeys.has(k));

writeFileSync(join(root, "vocalset-index.json"), JSON.stringify({ hop: HOP, entries }, null, 1));

// coverage report
const annotated = entries.filter((e) => e.annotation).length;
console.log(`${entries.length} recordings, ${annotated} annotated; ${orphans.length} annotations without a recording ${orphans.slice(0, 5).join(" ")}`);
for (const m of problems) console.log(`  ${m}`);
const by = (f: (e: Entry) => string) => {
  const m = new Map<string, [number, number, number]>();
  for (const e of entries) {
    const k = f(e);
    const v = m.get(k) ?? [0, 0, 0];
    v[0]++;
    if (e.annotation) v[1]++;
    v[2] += e.seconds;
    m.set(k, v);
  }
  return [...m].sort();
};
console.log("\ncontext/technique: recordings, annotated, minutes");
for (const [k, [n, a, s]] of by((e) => `${e.context}/${e.technique}`)) console.log(`  ${k.padEnd(26)} ${String(n).padStart(4)} ${String(a).padStart(4)} ${(s / 60).toFixed(1).padStart(6)}`);
console.log("\nstraight long tones (one vowel, one pitch) per singer: vowels present, median F0 (Hz)");
const singers = [...new Set(entries.map((e) => e.singer))].sort((a, b) => a[0].localeCompare(b[0]) || Number(a.slice(1)) - Number(b.slice(1)));
for (const s of singers) {
  const lt = entries.filter((e) => e.singer === s && e.context === "long_tones" && e.technique === "straight");
  const vowels = [...new Set(lt.map((e) => e.vowel ?? "?"))].sort().join("");
  const f0 = lt.map((e) => e.f0Median).filter((v): v is number => v !== null).sort((a, b) => a - b);
  console.log(`  ${s.padEnd(4)} ${String(lt.length).padStart(2)} files, vowels ${vowels.padEnd(5)} F0 ${f0.length ? `${f0[0]}-${f0[f0.length - 1]}` : "-"}`);
}
