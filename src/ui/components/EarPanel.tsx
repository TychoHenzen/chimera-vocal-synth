import { useEffect, useState } from "react";
import { EarRunner } from "../../evolve/ear.ts";
import { Screen } from "./Screen.tsx";

/** One ear runner for the page's life, like the Evolve page's runner. */
export const ear = new EarRunner();

/**
 * Two (or more) clips looping together from the same instant; one is heard at a time and
 * switching is instant, so the listener compares the same moment of each voice. Separate players,
 * one after the other, made comparisons slow and unreliable.
 */
let looper: { ctx: AudioContext; gains: GainNode[]; srcs: AudioBufferSourceNode[] } | null = null;

function stopLoop(): void {
  if (!looper) return;
  for (const s of looper.srcs) {
    try {
      s.stop();
    } catch {
      /* already stopped */
    }
  }
  void looper.ctx.close();
  looper = null;
}

function startLoop(clips: Float32Array[], gains: number[], on: number): void {
  stopLoop();
  const ctx = new AudioContext({ sampleRate: 48000 });
  const len = Math.max(...clips.map((c) => c.length));
  const at = ctx.currentTime + 0.05;
  const nodes = clips.map((c, k) => {
    const buf = ctx.createBuffer(1, len, 48000);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < c.length; i++) ch[i] = c[i] * gains[k];
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const g = ctx.createGain();
    g.gain.value = k === on ? 1 : 0;
    src.connect(g).connect(ctx.destination);
    src.start(at);
    return { src, g };
  });
  looper = { ctx, gains: nodes.map((n) => n.g), srcs: nodes.map((n) => n.src) };
}

/** Hear clip `on` of the loop; a 10 ms crossfade keeps the switch from clicking. */
function switchLoop(on: number): void {
  if (!looper) return;
  const t = looper.ctx.currentTime;
  looper.gains.forEach((g, k) => {
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(g.gain.value, t);
    g.gain.linearRampToValueAtTime(k === on ? 1 : 0, t + 0.01);
  });
}

function useEar(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => ear.subscribe(() => setTick((t) => t + 1)), []);
  return tick;
}

export function EarPanel(props: { label: string }) {
  useEar();
  const q = ear.question;
  /** what is playing: "q0"/"q1" (the question's A/B), "f0"/"f1" (favourite/default), or "" */
  const [on, setOn] = useState("");
  const [saved, setSaved] = useState("");

  // a new question starts playing A if the last one was playing
  useEffect(() => {
    if (!q) return;
    if (on.startsWith("q")) {
      startLoop(q.samples, q.gains, 0);
      setOn("q0");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  useEffect(() => () => stopLoop(), []);

  const hear = (id: string) => {
    if (on === id) {
      stopLoop();
      return setOn("");
    }
    const k = Number(id[1]);
    if (on[0] === id[0] && looper) switchLoop(k);
    else if (id[0] === "q" && q) startLoop(q.samples, q.gains, k);
    else if (id[0] === "f" && ear.favourite) startLoop(ear.favourite.samples, ear.favourite.gains, k);
    else return;
    setOn(id);
  };
  const answer = (choice: "a" | "b" | "same") => {
    if (!q) return;
    void ear.answer(choice);
  };

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === "a") hear("q0");
      else if (e.key === "b") hear("q1");
      else if (e.key === "1") answer("a");
      else if (e.key === "2") answer("same");
      else if (e.key === "3") answer("b");
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  const likes = ear.learned.slice().sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
  const top = Math.max(1e-9, ...likes.map((l) => Math.abs(l.w)));
  const fav = ear.favourite;
  const sw = ear.weights;
  const setWeight = (k: keyof typeof sw, v: number) => {
    if (Number.isFinite(v)) ear.weights = { ...sw, [k]: v };
  };

  return (
    <>
      <Screen className="ev-ear" title="Which sounds better?" sub={ear.error || ear.status}>
        <div className="ev-body">
          <div className="ev-row ev-ab">
            <button className={on === "q0" ? "on" : ""} disabled={!q} onClick={() => hear("q0")}>
              A
            </button>
            <button className={on === "q1" ? "on" : ""} disabled={!q} onClick={() => hear("q1")}>
              B
            </button>
            <span className="hint">both loop together, so switching keeps your place; each plays at the same loudness. Keys: A and B switch, 1 / 2 / 3 answer</span>
          </div>
          <div className="ev-row">
            <button className="primary" disabled={!q} onClick={() => answer("a")}>
              A is better
            </button>
            <button className="primary" disabled={!q} onClick={() => answer("same")}>
              Same
            </button>
            <button className="primary" disabled={!q} onClick={() => answer("b")}>
              B is better
            </button>
          </div>
          <p className="ev-status">
            {ear.answers.length} answers
            {ear.model ? ` / a fit on the others predicts ${ear.agree.right} of ${ear.agree.of} decisive answers` : " / the model starts after 3 answers"}
            {` / ${ear.generations} search generations, ${ear.voices.length} voices tried`}
          </p>
        </div>
      </Screen>

      <Screen
        className="ev-likes"
        title="What you seem to like"
        sub={ear.model ? "weight per standard deviation of each feature: amber, more is better; red, less is better" : "after a few answers"}
        tools={
          <>
            <button className="chip" disabled={!ear.running || !ear.voices.length} onClick={() => void ear.renderFavourite()}>
              Render the favourite
            </button>
            <button className={`chip${on === "f0" ? " on" : ""}`} disabled={!fav} onClick={() => hear("f0")}>
              Favourite
            </button>
            <button className={`chip${on === "f1" ? " on" : ""}`} disabled={!fav} onClick={() => hear("f1")}>
              Default
            </button>
            <button
              className="chip"
              disabled={!fav}
              onClick={async () => {
                if (!fav) return;
                const v = ear.voices[fav.index];
                const body = JSON.stringify({ song: props.label, genes: ear.named(v.x), rating: ear.rate(fav.index), answers: ear.answers.length }, null, 1);
                try {
                  const r = await fetch("/voiceref/save/ear-favourite.json", { method: "POST", body });
                  setSaved(r.ok ? `saved to ${await r.text()}` : "save failed");
                } catch {
                  setSaved("save failed: no dev server");
                }
              }}
            >
              Save favourite
            </button>
          </>
        }
      >
        <div className="ev-body">
          <div className="ev-row">
            <label>
              Caution (spreads)
              <input type="number" min={0} max={4} step={0.25} value={sw.caution} onChange={(e) => setWeight("caution", Number(e.target.value))} />
            </label>
            <label>
              Beyond what you heard (SD)
              <input type="number" min={0.05} max={3} step={0.05} value={sw.beyond} onChange={(e) => setWeight("beyond", Math.max(0.05, Number(e.target.value)))} />
            </label>
            <label>
              Pull to default
              <input type="number" min={0} max={20} step={0.5} value={sw.pull} onChange={(e) => setWeight("pull", Number(e.target.value))} />
            </label>
            <span className="hint">the search takes these up at your next answer{saved ? ` / ${saved}` : ""}</span>
          </div>
          {fav && <p className="hint">favourite: voice {fav.index} of {ear.voices.length}{ear.rate(fav.index) ? `, reward ${ear.rate(fav.index)!.r.toFixed(2)} (default ${ear.rate(0)!.r.toFixed(2)})` : ""}</p>}
          <div className="ev-table">
            <table>
              <tbody>
                {likes.map((l) => (
                  <tr key={l.name}>
                    <td>{l.name}</td>
                    <td>{l.w.toFixed(2)}</td>
                    <td>
                      <span className="ev-weight">
                        <b className={l.w < 0 ? "neg" : ""} style={l.w < 0 ? { right: "50%", width: `${(50 * -l.w) / top}%` } : { left: "50%", width: `${(50 * l.w) / top}%` }} />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Screen>
    </>
  );
}
