/**
 * The listener's saved A/B answers (Evolve's ear mode), by gene name so they survive a change of
 * clip or genome: out/evolve/ear-answers.json through the dev server, and the browser's storage.
 */
const FILE = "ear-answers.json";
const STORE = "chimera.ear.answers";

/** One answer, by gene name and value, so it survives a change of genome. */
export interface Answer {
  a: Record<string, number>;
  b: Record<string, number>;
  /** 1: A was better, 0: B was, 0.5: the same */
  y: number;
  /** ms since 1970 */
  at: number;
}

/** The saved answers: the dev server's copy, else the browser's, else none. */
export async function loadAnswers(): Promise<Answer[]> {
  try {
    const r = await fetch(`/voiceref/saved/${FILE}`);
    if (r.ok) return ((await r.json()) as { answers: Answer[] }).answers ?? [];
  } catch {
    /* no dev server */
  }
  try {
    const s = localStorage.getItem(STORE);
    if (s) return (JSON.parse(s) as { answers: Answer[] }).answers ?? [];
  } catch {
    /* storage blocked */
  }
  return [];
}

export async function saveAnswers(answers: Answer[]): Promise<void> {
  const body = JSON.stringify({ version: 1, answers }, null, 1);
  try {
    localStorage.setItem(STORE, body);
  } catch {
    /* storage blocked: the server copy still counts */
  }
  try {
    await fetch(`/voiceref/save/${FILE}`, { method: "POST", body });
  } catch {
    /* no dev server: the browser copy still counts */
  }
}
