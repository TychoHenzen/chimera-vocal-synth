/**
 * One evolution worker: its own copy of the engine, holding the recording and notes, scoring
 * the candidate voices it is sent. Messages run one at a time, in order (see runner.ts).
 */
import { call, initChimera } from "../wasm/chimera.ts";

export type Job = { type: "init"; problem: Record<string, unknown> } | { type: "eval"; xs: number[][] } | { type: "render"; x: number[] };
export type ToWorker = Job & { id: number };

export type FromWorker = { type: "done"; id: number; result: unknown } | { type: "error"; id: number; error: string };

self.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  try {
    let result: unknown;
    if (m.type === "init") {
      await initChimera();
      result = call("evolveProblem", m.problem);
    } else if (m.type === "eval") result = call("evolveEval", { xs: m.xs });
    else result = call("evolveRender", { x: m.x });
    (self as unknown as Worker).postMessage({ type: "done", id: m.id, result } satisfies FromWorker);
  } catch (e) {
    (self as unknown as Worker).postMessage({ type: "error", id: m.id, error: e instanceof Error ? e.message : String(e) } satisfies FromWorker);
  }
};
