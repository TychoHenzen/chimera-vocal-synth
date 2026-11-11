/** Evolve's workers, each with its own engine; jobs sent to one worker run in order. */
import type { FromWorker, Job, ToWorker } from "./worker.ts";

export class Pool {
  private workers: Worker[] = [];
  private pending = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
  private next = 1;

  constructor(n: number) {
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (ev: MessageEvent<FromWorker>) => {
        const p = this.pending.get(ev.data.id);
        if (!p) return;
        this.pending.delete(ev.data.id);
        if (ev.data.type === "done") p.ok(ev.data.result);
        else p.fail(new Error(ev.data.error));
      };
      w.onerror = (ev) => {
        // a worker that dies takes its jobs with it
        for (const p of this.pending.values()) p.fail(new Error(ev.message || "worker failed"));
        this.pending.clear();
      };
      this.workers.push(w);
    }
  }

  get size(): number {
    return this.workers.length;
  }

  send<T>(i: number, m: Job): Promise<T> {
    const id = this.next++;
    return new Promise<T>((ok, fail) => {
      this.pending.set(id, { ok: ok as (v: unknown) => void, fail });
      this.workers[i].postMessage({ ...m, id } as ToWorker);
    });
  }

  /** Send the same job to the first n workers and wait for all of them. */
  all<T>(n: number, m: Job): Promise<T[]> {
    return Promise.all(Array.from({ length: n }, (_, i) => this.send<T>(i, m)));
  }

  close(): void {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    for (const p of this.pending.values()) p.fail(new Error("stopped"));
    this.pending.clear();
  }
}
