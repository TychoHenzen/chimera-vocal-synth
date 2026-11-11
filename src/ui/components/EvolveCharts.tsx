/** The Evolve page's run charts: loss, its parts, step size, genes, spectrograms and the best voice. */
import { useEffect, useRef } from "react";
import { INK, drawGenes, drawSeries, drawSpectro } from "../../evolve/charts.ts";
import { download } from "../../evolve/playback.ts";
import type { EvolveRunner } from "../../evolve/runner.ts";
import type { Gene } from "../../evolve/types.ts";
import { Screen } from "./Screen.tsx";

/** A canvas redrawn whenever `deps` change and whenever its box resizes. */
export function Canvas(props: { draw: (c: HTMLCanvasElement) => void; deps: unknown[]; className?: string }) {
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

/** Play a clip by id (the same id again stops it); `songT0` moves the playhead. */
export type Listen = (id: string, samples: ArrayLike<number> | undefined, rate?: number, songT0?: number) => void;

interface ChartsProps {
  runner: EvolveRunner;
  /** re-renders on every runner change */
  tick: number;
  song: { label: string; rate: number } | null;
  first: number;
  last: number;
  playing: string;
  listen: Listen;
  /** the recording under the engine's clip */
  recordingSamples: Float32Array | undefined;
}

const COMP_INK = [INK.blue, INK.amber, INK.green, INK.pink];

export function EvolveCharts(props: ChartsProps) {
  const { runner, tick } = props;
  const h = runner.history;
  const info = runner.info;
  const lastRec = h[h.length - 1];
  const sweep = runner.sweep;
  const genes: Gene[] = info?.genes ?? [];
  const chartGenes = sweep && info ? genes.slice(0, info.nGlobal) : genes;
  return (
    <>
      <Screen className="ev-loss" title="Loss" sub={sweep ? "log scale, lower is closer; dashed lines start a new window (a new clip, so the level jumps)" : "log scale, lower is closer"}>
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
              { logY: true, marks: sweep?.marks.map((m) => m + 0.5) },
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
              info.compNames.map((n, i) => ({
                label: n,
                color: COMP_INK[i % 4],
                pts: h.map((r) => [r.gen, r.comps[i] * info.compWeights[i]] as [number, number]),
              })),
              { zeroY: true },
            )
          }
        />
        <div className="ev-legend">
          {info?.compNames.map((n, i) => (
            <span key={n} style={{ color: COMP_INK[i % 4] }}>
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
        <Canvas deps={[tick]} draw={(c) => drawGenes(c, h, chartGenes.map((g) => g.name))} />
      </Screen>

      <Spectrograms {...props} />
      <BestVoice {...props} genes={genes} />
    </>
  );
}

function Spectrograms({ runner, tick, song, playing, listen, recordingSamples }: ChartsProps) {
  const info = runner.info;
  const chip = (id: string) => `chip${playing === id ? " on" : ""}`;
  return (
    <Screen
      className="ev-spec"
      title="Spectrograms"
      sub={runner.picture ? `best at generation ${runner.pictureGen}` : "recording / best render / difference"}
      tools={
        <>
          <button className={chip("ref")} disabled={!recordingSamples} onClick={() => listen("ref", recordingSamples, song?.rate)}>
            {playing === "ref" ? "Stop" : "Hear recording"}
          </button>
          <button className={chip("best")} disabled={!runner.picture} onClick={() => listen("best", runner.picture?.samples)}>
            {playing === "best" ? "Stop" : "Hear best"}
          </button>
          <button className={chip("default")} disabled={!runner.defaultPicture} onClick={() => listen("default", runner.defaultPicture?.samples)}>
            {playing === "default" ? "Stop" : "Hear default voice"}
          </button>
        </>
      }
    >
      <Canvas deps={[tick]} draw={(c) => runner.picture && info && drawSpectro(c, runner.picture.ref, runner.picture.sim, info.bands)} />
    </Screen>
  );
}

function BestVoice({ runner, song, first, last, genes }: ChartsProps & { genes: Gene[] }) {
  const values = (x: number[]) => x.map((u, i) => genes[i].lo + u * (genes[i].hi - genes[i].lo));
  const saveBest = () => {
    const best = values(runner.bestX);
    const json = {
      song: song?.label,
      notes: [first, last],
      loss: runner.best,
      genes: genes.map((g, i) => ({ ...g, value: best[i], unit: runner.bestX[i] })),
      vowels: runner.picture?.vowels,
    };
    download(`best-${song?.label ?? "voice"}.json`, JSON.stringify(json, null, 2));
  };
  return (
    <Screen
      className="ev-params"
      title="Best voice"
      sub={runner.picture ? `sung vowels: ${runner.picture.vowels.map((v) => v ?? "-").join(" ")}` : ""}
      tools={
        <button className="chip" disabled={!runner.history.length} onClick={saveBest}>
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
  );
}
