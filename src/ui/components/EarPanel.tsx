import { useEffect, useState } from "react";
import { EarRunner } from "../../evolve/ear.ts";
import { isLooping, startLoop, stopLoop, switchLoop } from "../../evolve/looper.ts";
import { useStore } from "../store.ts";
import { Screen } from "./Screen.tsx";

/** One ear runner for the page's life, like the Evolve page's runner. */
export const ear = new EarRunner();

type Choice = "a" | "b" | "same";

function useEar(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => ear.subscribe(() => setTick((t) => t + 1)), []);
  return tick;
}

/** A and B switch the loop, 1 / 2 / 3 answer; typing in a field is left alone. */
function useKeys(hear: (id: string) => void, answer: (c: Choice) => void): void {
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
}

export function EarPanel(props: { label: string }) {
  useEar();
  const q = ear.question;
  /** what is playing: "q0"/"q1" (the question's A/B), "f0"/"f1" (favourite/default), or "" */
  const [on, setOn] = useState("");

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
    if (on[0] === id[0] && isLooping()) switchLoop(k);
    else if (id[0] === "q" && q) startLoop(q.samples, q.gains, k);
    else if (id[0] === "f" && ear.favourite) startLoop(ear.favourite.samples, ear.favourite.gains, k);
    else return;
    setOn(id);
  };
  const answer = (choice: Choice) => {
    if (!q) return;
    // the answered pair stops at once; the next question starts playing A when it arrives (above)
    if (on.startsWith("q")) {
      stopLoop();
      setOn("q");
    }
    void ear.answer(choice);
  };
  useKeys(hear, answer);

  return (
    <>
      <Question on={on} hear={hear} answer={answer} />
      <Likes label={props.label} on={on} hear={hear} />
    </>
  );
}

interface Playing {
  on: string;
  hear: (id: string) => void;
}

function Question({ on, hear, answer }: Playing & { answer: (c: Choice) => void }) {
  const q = ear.question;
  return (
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
          {q && ` / this pair differs by ${q.apart.toFixed(2)} SD per feature`}
        </p>
      </div>
    </Screen>
  );
}

/** Write the favourite's genes to out/evolve/ through the dev server; returns what to tell the user. */
async function saveFavourite(label: string, index: number): Promise<string> {
  const v = ear.voices[index];
  const body = JSON.stringify({ song: label, genes: ear.named(v.x), rating: ear.rate(index), answers: ear.answers.length }, null, 1);
  try {
    const r = await fetch("/voiceref/save/ear-favourite.json", { method: "POST", body });
    return r.ok ? `saved to ${await r.text()}` : "save failed";
  } catch {
    return "save failed: no dev server";
  }
}

function Likes({ label, on, hear }: Playing & { label: string }) {
  const [saved, setSaved] = useState("");
  const fav = ear.favourite;
  const adopt = (index: number) => {
    const v = ear.voices[index];
    useStore.getState().setFavourite({ genes: ear.named(v.x), body: ear.body, song: label, answers: ear.answers.length, at: Date.now() });
    setSaved("the other pages now sing with it (switch it off with Evolved voice, above the vocal tract)");
  };
  return (
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
          <button className="chip" disabled={!fav} onClick={async () => fav && setSaved(await saveFavourite(label, fav.index))}>
            Save favourite
          </button>
          <button className="chip" disabled={!fav} onClick={() => fav && adopt(fav.index)}>
            Use as my voice
          </button>
        </>
      }
    >
      <div className="ev-body">
        <SearchWeights saved={saved} />
        {fav && (
          <p className="hint">
            favourite: voice {fav.index} of {ear.voices.length}
            {ear.rate(fav.index) ? `, reward ${ear.rate(fav.index)!.r.toFixed(2)} (default ${ear.rate(0)!.r.toFixed(2)})` : ""}
          </p>
        )}
        <LikesTable />
      </div>
    </Screen>
  );
}

/** The search's knobs: they take effect at the next answer. */
function SearchWeights({ saved }: { saved: string }) {
  const sw = ear.weights;
  const setWeight = (k: keyof typeof sw, v: number) => {
    if (Number.isFinite(v)) ear.weights = { ...sw, [k]: v };
  };
  return (
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
  );
}

/** The learned weights, strongest first, as bars either side of zero. */
function LikesTable() {
  const likes = ear.learned.slice().sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
  const top = Math.max(1e-9, ...likes.map((l) => Math.abs(l.w)));
  return (
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
  );
}
