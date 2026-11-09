import { useEffect, useMemo, useRef, useState } from "react";
import { call } from "../../wasm/chimera.ts";
import { EvolveRunner, type CsdNote, type Gene, type SavedRun } from "../../evolve/runner.ts";
import { INK, drawGenes, drawSeries, drawSpectro } from "../../evolve/charts.ts";
import { Screen } from "./Screen.tsx";

/** One runner for the page's life: switching modes does not stop a run. */
const runner = new EvolveRunner();

interface Loaded {
  label: string;
  notes: CsdNote[];
  samples: Float32Array;
  rate: number;
}
let loadedSong: Loaded | null = null;

async function decodeAudio(buf: ArrayBuffer): Promise<{ samples: Float32Array; rate: number }> {
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

let player: { ctx: AudioContext; src: AudioBufferSourceNode } | null = null;
function stopPlaying(): void {
  if (!player) return;
  try {
    player.src.stop();
  } catch {
    /* already ended */
  }
  void player.ctx.close();
  player = null;
}
function play(samples: ArrayLike<number>, rate: number, onEnd: () => void): void {
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
  player = { ctx, src };
}

function download(name: string, text: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function useRunner(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => runner.subscribe(() => setTick((t) => t + 1)), []);
  return tick;
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

function Canvas(props: { draw: (c: HTMLCanvasElement) => void; deps: unknown[]; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    props.draw(c);
    const ro = new ResizeObserver(() => props.draw(c));
    ro.observe(c);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, props.deps);
  return <canvas ref={ref} className={props.className} />;
}

export function EvolvePage() {
  const tick = useRunner();
  const [song, setSong] = useState<Loaded | null>(loadedSong);
  const [available, setAvailable] = useState<string[]>([]);
  const [pick, setPick] = useState("");
  const [loading, setLoading] = useState("");
  const [msg, setMsg] = useState("");
  const [first, setFirst] = useState(0);
  const [last, setLast] = useState(0);
  const [pop, setPop] = useState(32);
  const [sigma, setSigma] = useState(0.2);
  const [seed, setSeed] = useState(1);
  const cores = navigator.hardwareConcurrency || 4;
  const [workers, setWorkers] = useState(Math.max(1, Math.min(16, cores - 1)));
  const [playing, setPlaying] = useState("");
  const wavFile = useRef<HTMLInputElement>(null);
  const csvFile = useRef<HTMLInputElement>(null);
  const [pendingWav, setPendingWav] = useState<{ name: string; buf: ArrayBuffer } | null>(null);
  const [pendingCsv, setPendingCsv] = useState<{ name: string; text: string } | null>(null);
  const [resume, setResume] = useState<SavedRun | null>(null);

  // songs the dev server can hand over from voiceRef/
  useEffect(() => {
    fetch("/voiceref/list")
      .then((r) => (r.ok ? r.json() : { songs: [] }))
      .then((j: { songs: string[] }) => {
        setAvailable(j.songs);
        if (j.songs.length) setPick(j.songs.includes("en042a") ? "en042a" : j.songs[0]);
      })
      .catch(() => {});
  }, []);

  const install = (s: Loaded) => {
    loadedSong = s;
    setSong(s);
    const n = s.notes.findIndex((x) => x.syl.phraseEnd);
    setFirst(0);
    setLast(n >= 0 ? n : s.notes.length - 1);
    setMsg("");
  };

  const loadFromServer = async () => {
    setLoading(`loading ${pick}`);
    try {
      const [csv, wav] = await Promise.all([fetch(`/voiceref/csd/${pick}.csv`).then((r) => r.text()), fetch(`/voiceref/csd/${pick}.wav`).then((r) => r.arrayBuffer())]);
      const notes = call<CsdNote[]>("csdNotes", { text: csv });
      const a = await decodeAudio(wav);
      install({ label: pick, notes, ...a });
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading("");
    }
  };

  const loadFromFiles = async () => {
    if (!pendingWav || !pendingCsv) return;
    setLoading("decoding");
    try {
      const notes = call<CsdNote[]>("csdNotes", { text: pendingCsv.text });
      const a = await decodeAudio(pendingWav.buf);
      install({ label: pendingWav.name.replace(/\.[^.]+$/, ""), notes, ...a });
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading("");
    }
  };

  const clip = useMemo(() => {
    if (!song || !song.notes[first] || !song.notes[last]) return null;
    const clip0 = Math.max(0, song.notes[first].start - 0.4);
    const clip1 = song.notes[last].end + 0.5;
    const t0 = Math.max(0, clip0 - 0.1);
    const t1 = clip1 + 0.1;
    const a = Math.floor(t0 * song.rate);
    const b = Math.min(song.samples.length, Math.ceil(t1 * song.rate));
    const wav = new Int16Array(Math.max(0, b - a));
    for (let i = 0; i < wav.length; i++) wav[i] = Math.max(-32768, Math.min(32767, Math.round(song.samples[a + i] * 32767)));
    return { wav, wavT0: t0, clip0, seconds: clip1 - clip0 };
  }, [song, first, last]);

  const start = (withResume: boolean) => {
    if (!song || !clip) return;
    void runner.start({
      notes: song.notes,
      first,
      last,
      wav: clip.wav,
      rate: song.rate,
      wavT0: clip.wavT0,
      pop,
      sigma,
      seed,
      workers,
      resume: withResume && resume ? resume : undefined,
      label: song.label,
    });
  };

  const h = runner.history;
  const info = runner.info;
  const lastRec = h[h.length - 1];
  const genes: Gene[] = info?.genes ?? [];
  const listen = (id: string, samples: ArrayLike<number> | undefined, rate = 48000) => {
    if (!samples) return;
    if (playing === id) {
      stopPlaying();
      setPlaying("");
      return;
    }
    setPlaying(id);
    play(samples, rate, () => setPlaying((p) => (p === id ? "" : p)));
  };
  const recordingSamples = useMemo(() => {
    // the engine trims the clip to the notes' neighbours: use its own clip start and length
    if (!song || !clip || !runner.info) return undefined;
    const a = Math.round(runner.info.clip0 * song.rate);
    return song.samples.subarray(a, Math.min(song.samples.length, a + Math.round(runner.info.seconds * song.rate)));
  }, [song, clip, tick]);

  const values = (x: number[]) => x.map((u, i) => genes[i].lo + u * (genes[i].hi - genes[i].lo));

  return (
    <div className="evolve">
      <Screen className="ev-setup" title="Recording" sub={song ? `${song.label} / ${song.notes.length} notes` : "choose a song"}>
        <div className="ev-body">
          {available.length > 0 && (
            <div className="ev-row">
              <label>
                From voiceRef
                <select value={pick} onChange={(e) => setPick(e.target.value)}>
                  {available.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
              <button className="primary" disabled={!!loading || runner.running} onClick={() => void loadFromServer()}>
                Load
              </button>
            </div>
          )}
          <div className="ev-row">
            <label>
              Recording (wav, mp3, ...)
              <input
                ref={wavFile}
                type="file"
                accept="audio/*"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (f) setPendingWav({ name: f.name, buf: await f.arrayBuffer() });
                }}
              />
            </label>
            <label>
              Notes (CSD csv: start,end,pitch,syllable)
              <input
                ref={csvFile}
                type="file"
                accept=".csv,text/csv,text/plain"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (f) setPendingCsv({ name: f.name, text: await f.text() });
                }}
              />
            </label>
            <button disabled={!pendingWav || !pendingCsv || !!loading || runner.running} onClick={() => void loadFromFiles()}>
              Use these files
            </button>
          </div>
          {loading && <p className="hint">{loading}...</p>}
          {msg && <p className="error">{msg}</p>}
          {song && (
            <>
              <div className="ev-row">
                <label>
                  First note
                  <input type="number" min={0} max={song.notes.length - 1} value={first} disabled={runner.running} onChange={(e) => setFirst(Math.max(0, Math.min(Number(e.target.value), last)))} />
                </label>
                <label>
                  Last note
                  <input type="number" min={first} max={song.notes.length - 1} value={last} disabled={runner.running} onChange={(e) => setLast(Math.max(first, Math.min(Number(e.target.value), song.notes.length - 1)))} />
                </label>
                <span className="hint">{song.notes.slice(first, last + 1).map((n) => n.csd).join(" ")}</span>
              </div>
              <div className="ev-row">
                <label>
                  Population
                  <input type="number" min={4} max={128} value={pop} disabled={runner.running} onChange={(e) => setPop(Math.max(4, Number(e.target.value)))} />
                </label>
                <label>
                  Workers (of {cores} cores)
                  <input type="number" min={1} max={cores} value={workers} disabled={runner.running} onChange={(e) => setWorkers(Math.max(1, Number(e.target.value)))} />
                </label>
                <label>
                  Step size
                  <input type="number" min={0.02} max={0.5} step={0.02} value={sigma} disabled={runner.running} onChange={(e) => setSigma(Number(e.target.value))} />
                </label>
                <label>
                  Seed
                  <input type="number" value={seed} disabled={runner.running} onChange={(e) => setSeed(Number(e.target.value))} />
                </label>
              </div>
              <div className="ev-row">
                {runner.running ? (
                  <button className="primary" onClick={() => runner.stop()}>
                    Stop
                  </button>
                ) : (
                  <>
                    <button className="primary" onClick={() => start(false)}>
                      Start a new run
                    </button>
                    {resume && (
                      <button onClick={() => start(true)}>
                        Continue loaded run ({resume.history.length} generations)
                      </button>
                    )}
                  </>
                )}
                <button disabled={!h.length} onClick={() => download(`evolve-${song.label}-${first}-${last}.run.json`, JSON.stringify(runner.save()))}>
                  Save run
                </button>
                <label className="ev-file">
                  Load run
                  <input
                    type="file"
                    accept=".json,application/json"
                    disabled={runner.running}
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      try {
                        const r = JSON.parse(await f.text()) as SavedRun;
                        if (r.version !== 1) throw new Error("not a saved run");
                        setResume(r);
                        setFirst(r.first);
                        setLast(r.last);
                        setMsg("");
                      } catch (err) {
                        setMsg(err instanceof Error ? err.message : String(err));
                      }
                    }}
                  />
                </label>
              </div>
            </>
          )}
          <p className="ev-status">
            {runner.error ? <span className="error">{runner.error}</span> : runner.status || (song ? "ready" : "")}
            {lastRec && (
              <>
                {" "}
                / generation {lastRec.gen} / {lastRec.evals} voices scored / best loss {runner.best?.loss.toFixed(3)} / {fmtTime(lastRec.elapsed)}
              </>
            )}
          </p>
        </div>
      </Screen>

      <Screen className="ev-loss" title="Loss" sub="log scale, lower is closer">
        <Canvas
          deps={[tick]}
          draw={(c) =>
            drawSeries(
              c,
              [
                { label: "worst", color: INK.red, pts: h.map((r) => [r.gen, r.worst]) },
                { label: "median", color: INK.green, pts: h.map((r) => [r.gen, r.median]) },
                { label: "generation best", color: INK.amber, pts: h.map((r) => [r.gen, r.genBest]) },
                { label: "best so far", color: INK.blue, pts: h.map((r) => [r.gen, r.best]) },
              ],
              { logY: true },
            )
          }
        />
        <div className="ev-legend">
          <span style={{ color: INK.blue }}>best so far</span>
          <span style={{ color: INK.amber }}>generation best</span>
          <span style={{ color: INK.green }}>median</span>
          <span style={{ color: INK.red }}>worst</span>
        </div>
      </Screen>

      <Screen className="ev-comp" title="Parts of the loss" sub="weighted, of the best">
        <Canvas
          deps={[tick]}
          draw={(c) =>
            info &&
            drawSeries(
              c,
              info.compNames.map((n, i) => ({ label: n, color: [INK.blue, INK.amber, INK.green, INK.pink][i % 4], pts: h.map((r) => [r.gen, r.comps[i] * info.compWeights[i]] as [number, number]) })),
              { zeroY: true },
            )
          }
        />
        <div className="ev-legend">
          {info?.compNames.map((n, i) => (
            <span key={n} style={{ color: [INK.blue, INK.amber, INK.green, INK.pink][i % 4] }}>
              {n} {lastRec ? lastRec.comps[i].toFixed(3) : ""}
            </span>
          ))}
        </div>
      </Screen>

      <Screen className="ev-sigma" title="Step size" sub="shrinks as it settles">
        <Canvas deps={[tick]} draw={(c) => drawSeries(c, [{ label: "sigma", color: INK.pink, pts: h.map((r) => [r.gen, r.sigma]) }], { zeroY: true })} />
        <div className="ev-legend">
          <span style={{ color: INK.pink }}>sigma</span>
          {lastRec && <span>level gap {lastRec.gap.toFixed(1)} dB (render minus recording, part of the score)</span>}
        </div>
      </Screen>

      <Screen className="ev-genes" title="Genes of the best" sub="rows are knobs, columns generations, blue low and red high in the knob's range">
        <Canvas deps={[tick]} draw={(c) => drawGenes(c, h, genes.map((g) => g.name))} />
      </Screen>

      <Screen
        className="ev-spec"
        title="Spectrograms"
        sub={runner.picture ? `best at generation ${runner.pictureGen}` : "recording / best render / difference"}
        tools={
          <>
            <button className={`chip${playing === "ref" ? " on" : ""}`} disabled={!recordingSamples} onClick={() => listen("ref", recordingSamples, song?.rate)}>
              {playing === "ref" ? "Stop" : "Hear recording"}
            </button>
            <button className={`chip${playing === "best" ? " on" : ""}`} disabled={!runner.picture} onClick={() => listen("best", runner.picture?.samples)}>
              {playing === "best" ? "Stop" : "Hear best"}
            </button>
            <button className={`chip${playing === "default" ? " on" : ""}`} disabled={!runner.defaultPicture} onClick={() => listen("default", runner.defaultPicture?.samples)}>
              {playing === "default" ? "Stop" : "Hear default voice"}
            </button>
          </>
        }
      >
        <Canvas deps={[tick]} draw={(c) => runner.picture && info && drawSpectro(c, runner.picture.ref, runner.picture.sim, info.bands)} />
      </Screen>

      <Screen
        className="ev-params"
        title="Best voice"
        sub={runner.picture ? `sung vowels: ${runner.picture.vowels.map((v) => v ?? "-").join(" ")}` : ""}
        tools={
          <button
            className="chip"
            disabled={!h.length}
            onClick={() =>
              download(
                `best-${song?.label ?? "voice"}.json`,
                JSON.stringify({ song: song?.label, notes: [first, last], loss: runner.best, genes: genes.map((g, i) => ({ ...g, value: values(runner.bestX)[i], unit: runner.bestX[i] })), vowels: runner.picture?.vowels }, null, 2),
              )
            }
          >
            Download best.json
          </button>
        }
      >
        <div className="ev-table">
          <table>
            <thead>
              <tr>
                <th>knob</th>
                <th>default</th>
                <th>best</th>
                <th>range</th>
              </tr>
            </thead>
            <tbody>
              {genes.map((g, i) => {
                const u = runner.bestX[i] ?? (g.def - g.lo) / (g.hi - g.lo);
                const d = (g.def - g.lo) / (g.hi - g.lo);
                return (
                  <tr key={g.name}>
                    <td>{g.name}</td>
                    <td>{g.def.toFixed(2)}</td>
                    <td>{(g.lo + u * (g.hi - g.lo)).toFixed(2)}</td>
                    <td>
                      <span className="ev-bar">
                        <i style={{ left: `${d * 100}%` }} className="def" />
                        <i style={{ left: `${u * 100}%` }} className="val" />
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Screen>
    </div>
  );
}
