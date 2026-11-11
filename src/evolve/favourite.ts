/**
 * The voice the listener picked in "Learn from my ear", kept in the browser so the other pages
 * can sing with it. The engine turns the genes into a voice profile
 * (`crates/chimera/src/voice/profile.rs`); this module only stores them. No engine calls here:
 * the store imports it at startup.
 */
import type { SingerBody } from "./runner.ts";

export interface VoiceFavourite {
  /** Evolve's genes by name (decoded values) */
  genes: Record<string, number>;
  /** the body it was evolved on: the body genes are relative to it */
  body: SingerBody;
  song: string;
  /** how many answers the model had learned from */
  answers: number;
  at: number;
}

const KEY = "chimera.voice.favourite";
const ON = "chimera.voice.favourite.on";

export function loadFavourite(): VoiceFavourite | null {
  try {
    const s = localStorage.getItem(KEY);
    const f = s ? (JSON.parse(s) as VoiceFavourite) : null;
    return f && f.genes !== null && typeof f.genes === "object" && (f.body === "male" || f.body === "female") ? f : null;
  } catch {
    return null;
  }
}

export function saveFavourite(f: VoiceFavourite): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(f));
  } catch {
    /* storage blocked: it lasts until the page closes */
  }
}

export function loadFavouriteOn(): boolean {
  try {
    return localStorage.getItem(ON) === "1";
  } catch {
    return false;
  }
}

export function saveFavouriteOn(on: boolean): void {
  try {
    localStorage.setItem(ON, on ? "1" : "0");
  } catch {
    /* storage blocked */
  }
}
