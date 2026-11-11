import { useEffect, useMemo, useState } from "react";
import { EvolveRunner } from "../../evolve/runner.ts";
import { cutClip, singerOf, sweepWindows } from "../../evolve/sweep.ts";
import type { CsdNote, SavedRun, SingerBody } from "../../evolve/types.ts";
import { drawNotes, type NoteLook } from "../../evolve/charts.ts";
import { download, play, playingAt, saveWav, stopPlaying, wavBlob } from "../../evolve/playback.ts";
import { Canvas, EvolveCharts, type Listen } from "./EvolveCharts.tsx";
import { EarPanel, ear } from "./EarPanel.tsx";
import { Screen } from "./Screen.tsx";
import { SongPicker, type Loaded } from "./SongPicker.tsx";

/** One runner for the page's life: switching modes does not stop a run. */
const runner = new EvolveRunner();

let loadedSong: Loaded | null = null;

type Mode = "range" | "sweep" | "ear";

/** A note's syllable in the engine's IPA ("ka", "ɾo"), as the strip labels it. */
function sylText(n: CsdNote): string {
  const s = n.syl as { onset?: { ipa: string }[]; nucleus?: { ipa: string }; coda?: { ipa: string }[] };
  const ipa = [...(s.onset ?? []), ...(s.nucleus ? [s.nucleus] : []), ...(s.coda ?? [])].map((x) => x.ipa).join("");
  return ipa || n.csd;
}

function useRunner(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const a = runner.subscribe(() => setTick((t) => t + 1));
    const b = ear.subscribe(() => setTick((t) => t + 1));
    return () => {
      a();
      b();
    };
  }, []);
  return tick;
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

export function EvolvePage() {
  const tick = useRunner();
  const [song, setSong] = useState<Loaded | null>(loadedSong);
  const [msg, setMsg] = useState("");
  const [first, setFirst] = useState(0);
  const [last, setLast] = useState(0);
  const [pop, setPop] = useState(32);
  const [sigma, setSigma] = useState(0.2);
  const [seed, setSeed] = useState(1);
  const cores = navigator.hardwareConcurrency || 4;
  const [workers, setWorkers] = useState(Math.max(1, Math.min(16, cores - 1)));
  const [playing, setPlaying] = useState("");
  const [resume, setResume] = useState<SavedRun | null>(null);
  const [mode, setMode] = useState<Mode>("sweep");
  const [body, setBody] = useState<SingerBody>(() => singerOf(loadedSong?.label ?? ""));
  const [winSize, setWinSize] = useState(6);
  const [overlap, setOverlap] = useState(2);
  const [gens, setGens] = useState(30);
  const [maxGens, setMaxGens] = useState(200);
  /** song seconds under the playhead while a whole-section clip plays */
  const [playhead, setPlayhead] = useState<number | null>(null);
  /** where Save wav put the last render */
  const [saved, setSaved] = useState("");

  const install = (s: Loaded) => {
    loadedSong = s;
    setSong(s);
    setBody(singerOf(s.label));
    const n = s.notes.findIndex((x) => x.syl.phraseEnd);
    setFirst(0);
    setLast(n >= 0 ? n : s.notes.length - 1);
    setMsg("");
  };

  const clip = useMemo(() => (song && song.notes[first] && song.notes[last] ? cutClip(song.samples, song.rate, song.notes, first, last) : null), [song, first, last]);
  const windows = useMemo(() => (song ? sweepWindows(song.notes.length, winSize, overlap) : []), [song, winSize, overlap]);

  const start = (withResume: boolean) => {
    if (!song || !clip) return;
    if (mode === "ear") {
      void ear.start({ notes: song.notes, body, first, last, wav: clip.wav, rate: song.rate, wavT0: clip.wavT0, workers, seed });
      return;
    }
    if (mode === "sweep") {
      void runner.startSweep({ notes: song.notes, body, samples: song.samples, rate: song.rate, window: winSize, overlap, gens, maxGens, pop, sigma, seed, workers, label: song.label });
      return;
    }
    void runner.start({
      notes: song.notes,
      body: withResume && resume ? (resume.body ?? "female") : body,
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

  const loadRun = (r: SavedRun) => {
    setResume(r);
    setBody(r.body ?? "female");
    setFirst(r.first);
    setLast(r.last);
    setMsg("");
  };

  /** either optimiser is running: the setup is locked */
  const busy = runner.running || ear.running;
  const sweep = runner.sweep;
  const full = sweep?.full ?? null;
  const listen: Listen = (id, samples, rate = 48000, songT0) => {
    if (!samples) return;
    if (playing === id) {
      stopPlaying();
      setPlaying("");
      setPlayhead(null);
      return;
    }
    setPlaying(id);
    play(samples, rate, () => {
      setPlaying((p) => (p === id ? "" : p));
      setPlayhead(null);
    });
    if (songT0 === undefined) return setPlayhead(null);
    const step = () => {
      const at = playingAt();
      if (at === null) return;
      setPlayhead(songT0 + at);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  const fullRecording = useMemo(() => {
    if (!song || !full) return undefined;
    const a = Math.round(full.clip0 * song.rate);
    return song.samples.subarray(a, Math.min(song.samples.length, a + Math.round(full.seconds * song.rate)));
  }, [song, full]);
  const noteLooks: NoteLook[] = song
    ? song.notes.map((nt, k) => {
        const win = sweep && sweep.phase === "windows" ? sweep.windows[sweep.index] : null;
        const active = !!win && k >= win[0] && k <= win[1];
        const genes = sweep ? runner.noteValues(k) : null;
        return { start: nt.start, end: nt.end, midi: nt.midi, text: sylText(nt), state: active ? "active" : genes ? "done" : "pending", genes };
      })
    : [];
  const activeWin = sweep && sweep.phase === "windows" && runner.running ? (sweep.windows[sweep.index] ?? null) : null;
  const recordingSamples = useMemo(() => {
    // the engine trims the clip to the notes' neighbours: use its own clip start and length
    if (!song || !clip || !runner.info) return undefined;
    const a = Math.round(runner.info.clip0 * song.rate);
    return song.samples.subarray(a, Math.min(song.samples.length, a + Math.round(runner.info.seconds * song.rate)));
  }, [song, clip, tick]);

  return (
    <div className="evolve">
      <Screen className="ev-setup" title="Recording" sub={song ? `${song.label} / ${song.notes.length} notes` : "choose a song"}>
        <div className="ev-body">
          <SongPicker busy={busy} onLoaded={install} onError={setMsg} />
          {msg && <p className="error">{msg}</p>}
          {song && (
            <>
              <div className="ev-row">
                <label>
                  Mode
                  <select value={mode} disabled={busy} onChange={(e) => setMode(e.target.value as Mode)}>
                    <option value="sweep">Sweep the song, window by window</option>
                    <option value="range">One range of notes</option>
                    <option value="ear">Learn from my ear (A/B questions)</option>
                  </select>
                </label>
                <label>
                  Body
                  <select value={body} disabled={busy} onChange={(e) => setBody(e.target.value as SingerBody)}>
                    <option value="female">Female</option>
                    <option value="male">Male</option>
                  </select>
                </label>
                {mode === "sweep" && (
                  <>
                    <label>
                      Notes per window
                      <input type="number" min={2} max={16} value={winSize} disabled={busy} onChange={(e) => setWinSize(Math.max(2, Math.min(16, Number(e.target.value))))} />
                    </label>
                    <label>
                      Overlap
                      <input type="number" min={0} max={winSize - 1} value={overlap} disabled={busy} onChange={(e) => setOverlap(Math.max(0, Math.min(winSize - 1, Number(e.target.value))))} />
                    </label>
                    <label>
                      Generations per window, at least
                      <input type="number" min={1} max={500} value={gens} disabled={busy} onChange={(e) => setGens(Math.max(1, Number(e.target.value)))} />
                    </label>
                    <label>
                      at most
                      <input type="number" min={gens} max={2000} value={maxGens} disabled={busy} onChange={(e) => setMaxGens(Math.max(gens, Number(e.target.value)))} />
                    </label>
                    <span className="hint">
                      {windows.length} windows over {song.notes.length} notes. A window moves on once its best has stopped improving and the population has closed in; the first gets twice the generations (it also finds the voice)
                    </span>
                  </>
                )}
              </div>
              {(mode === "range" || mode === "ear") && (
              <div className="ev-row">
                <label>
                  First note
                  <input type="number" min={0} max={song.notes.length - 1} value={first} disabled={busy} onChange={(e) => setFirst(Math.max(0, Math.min(Number(e.target.value), last)))} />
                </label>
                <label>
                  Last note
                  <input type="number" min={first} max={song.notes.length - 1} value={last} disabled={busy} onChange={(e) => setLast(Math.max(first, Math.min(Number(e.target.value), song.notes.length - 1)))} />
                </label>
                <span className="hint">
                  {song.notes.slice(first, last + 1).map((n) => n.csd).join(" ")}
                  {mode === "ear" && " / every question plays these notes: a few seconds with several vowels works best"}
                </span>
              </div>
              )}
              <div className="ev-row">
                {mode !== "ear" && (
                <label>
                  Population
                  <input type="number" min={4} max={128} value={pop} disabled={busy} onChange={(e) => setPop(Math.max(4, Number(e.target.value)))} />
                </label>
                )}
                <label>
                  Workers (of {cores} cores)
                  <input type="number" min={1} max={cores} value={workers} disabled={busy} onChange={(e) => setWorkers(Math.max(1, Number(e.target.value)))} />
                </label>
                {mode !== "ear" && (
                <label>
                  Step size
                  <input type="number" min={0.02} max={0.5} step={0.02} value={sigma} disabled={busy} onChange={(e) => setSigma(Number(e.target.value))} />
                </label>
                )}
                <label>
                  Seed
                  <input type="number" value={seed} disabled={busy} onChange={(e) => setSeed(Number(e.target.value))} />
                </label>
              </div>
              <RunControls
                mode={mode}
                busy={busy}
                label={song.label}
                first={first}
                last={last}
                resume={resume}
                start={start}
                onLoaded={loadRun}
                onError={setMsg}
              />
            </>
          )}
          <RunStatus mode={mode} ready={!!song} />
        </div>
      </Screen>

      {sweep && song && (
        <Screen
          className="ev-notes"
          title="Notes"
          sub={
            full
              ? `whole section: loss ${full.eval.loss.toFixed(3)} (default voice ${full.defaultEval.loss.toFixed(3)}), level gap ${full.eval.gap.toFixed(1)} dB${saved ? `, ${saved}` : ""}`
              : "outline: as written / filled: as evolved (shift, length, cents; brighter is louder) / amber: the window being evolved"
          }
          tools={
            full && (
              <>
                <button className={`chip${playing === "full" ? " on" : ""}`} onClick={() => listen("full", full.picture.samples, 48000, full.clip0)}>
                  {playing === "full" ? "Stop" : "Hear the whole section"}
                </button>
                <button className={`chip${playing === "fullref" ? " on" : ""}`} disabled={!fullRecording} onClick={() => listen("fullref", fullRecording, song.rate, full.clip0)}>
                  {playing === "fullref" ? "Stop" : "Hear the recording"}
                </button>
                <button className={`chip${playing === "fulldef" ? " on" : ""}`} onClick={() => listen("fulldef", full.defaultPicture.samples, 48000, full.clip0)}>
                  {playing === "fulldef" ? "Stop" : "Hear the default voice"}
                </button>
                <button className="chip" onClick={() => void saveWav(`chimera-${song.label}-sweep.wav`, wavBlob(full.picture.samples, 48000), setSaved)}>
                  Save wav
                </button>
              </>
            )
          }
        >
          <Canvas deps={[tick, playhead]} draw={(c) => drawNotes(c, noteLooks, activeWin, playhead)} />
        </Screen>
      )}

      {mode === "ear" ? (
        <EarPanel label={song?.label ?? ""} />
      ) : (
        <EvolveCharts
          runner={runner}
          tick={tick}
          song={song}
          first={first}
          last={last}
          playing={playing}
          listen={listen}
          recordingSamples={recordingSamples}
        />
      )}
    </div>
  );
}

interface ControlsProps {
  mode: Mode;
  busy: boolean;
  /** the song's label, for the saved run's file name */
  label: string;
  first: number;
  last: number;
  resume: SavedRun | null;
  start: (withResume: boolean) => void;
  onLoaded: (r: SavedRun) => void;
  onError: (msg: string) => void;
}

/** Start, stop, save and load: the ear's buttons or the runner's. */
function RunControls(props: ControlsProps) {
  const { mode, busy, label, first, last, resume, start } = props;
  const sweep = runner.sweep;
  const h = runner.history;
  return mode === "ear" ? (
    <div className="ev-row">
      {ear.running ? (
        <button className="primary" onClick={() => ear.stop()}>
          Stop
        </button>
      ) : (
        <button className="primary" disabled={busy} onClick={() => start(false)}>
          Start listening
        </button>
      )}
      <span className="hint">your answers are kept in out/evolve/ear-answers.json and carry over to any clip</span>
    </div>
  ) : (
    <div className="ev-row">
      {runner.running ? (
        <>
          <button className="primary" onClick={() => runner.stop()}>
            Stop
          </button>
          {sweep?.phase === "windows" && <button onClick={() => runner.skipToFull()}>Sing the whole section now</button>}
        </>
      ) : (
        <>
          <button className="primary" onClick={() => start(false)}>
            {mode === "sweep" ? "Start a sweep" : "Start a new run"}
          </button>
          {resume && mode === "range" && (
            <button onClick={() => start(true)}>
              Continue loaded run ({resume.history.length} generations)
            </button>
          )}
        </>
      )}
      <button disabled={!h.length || !!sweep} onClick={() => download(`evolve-${label}-${first}-${last}.run.json`, JSON.stringify(runner.save()))}>
        Save run
      </button>
      <label className="ev-file">
        Load run
        <input
          type="file"
          accept=".json,application/json"
          disabled={busy}
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            try {
              const r = JSON.parse(await f.text()) as SavedRun;
              if (r.version !== 1) throw new Error("not a saved run");
              props.onLoaded(r);
            } catch (err) {
              props.onError(err instanceof Error ? err.message : String(err));
            }
          }}
        />
      </label>
    </div>
  );
}

/** One line: the running optimiser's status, or its error. */
function RunStatus({ mode, ready }: { mode: Mode; ready: boolean }) {
  const h = runner.history;
  const lastRec = h[h.length - 1];
  return mode === "ear" ? (
    <p className="ev-status">{ear.error ? <span className="error">{ear.error}</span> : ear.status || (ready ? "ready" : "")}</p>
  ) : (
    <p className="ev-status">
      {runner.error ? <span className="error">{runner.error}</span> : runner.status || (ready ? "ready" : "")}
      {lastRec && (
        <>
          {" "}
          / generation {lastRec.gen} / {lastRec.evals} voices scored / best loss {runner.best?.loss.toFixed(3)} / {fmtTime(lastRec.elapsed)}
        </>
      )}
    </p>
  );
}
