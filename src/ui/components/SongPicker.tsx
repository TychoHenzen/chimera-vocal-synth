/** The Evolve page's song picker: a song from voiceRef/ through the dev server, or a wav and its notes from disk. */
import { useEffect, useState } from "react";
import { decodeAudio } from "../../evolve/playback.ts";
import type { CsdNote } from "../../evolve/types.ts";
import { call } from "../../wasm/chimera.ts";

export interface Loaded {
  label: string;
  notes: CsdNote[];
  samples: Float32Array;
  rate: number;
}

interface PickerProps {
  /** an optimiser is running: loading is locked */
  busy: boolean;
  onLoaded: (s: Loaded) => void;
  onError: (msg: string) => void;
}

export function SongPicker(props: PickerProps) {
  const { busy } = props;
  const [available, setAvailable] = useState<string[]>([]);
  const [pick, setPick] = useState("");
  const [loading, setLoading] = useState("");
  const [pendingWav, setPendingWav] = useState<{ name: string; buf: ArrayBuffer } | null>(null);
  const [pendingCsv, setPendingCsv] = useState<{ name: string; text: string } | null>(null);

  // songs the dev server can hand over from voiceRef/
  useEffect(() => {
    fetch("/voiceref/list")
      .then((r) => (r.ok ? r.json() : { songs: [] }))
      .then((j: { songs: string[] }) => {
        setAvailable(j.songs);
        if (j.songs.length) setPick(j.songs.includes("csd/en042a") ? "csd/en042a" : j.songs[0]);
      })
      .catch(() => {});
  }, []);

  const loadFromServer = async () => {
    setLoading(`loading ${pick}`);
    try {
      const [csv, wav] = await Promise.all([fetch(`/voiceref/${pick}.csv`).then((r) => r.text()), fetch(`/voiceref/${pick}.wav`).then((r) => r.arrayBuffer())]);
      const notes = call<CsdNote[]>("csdNotes", { text: csv });
      const a = await decodeAudio(wav);
      props.onLoaded({ label: pick.replace(/^\w+\//, ""), notes, ...a });
    } catch (e) {
      props.onError(e instanceof Error ? e.message : String(e));
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
      props.onLoaded({ label: pendingWav.name.replace(/\.[^.]+$/, ""), notes, ...a });
    } catch (e) {
      props.onError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading("");
    }
  };

  return (
    <>
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
          <button className="primary" disabled={!!loading || busy} onClick={() => void loadFromServer()}>
            Load
          </button>
        </div>
      )}
      <div className="ev-row">
        <label>
          Recording (wav, mp3, ...)
          <input
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
            type="file"
            accept=".csv,text/csv,text/plain"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) setPendingCsv({ name: f.name, text: await f.text() });
            }}
          />
        </label>
        <button disabled={!pendingWav || !pendingCsv || !!loading || busy} onClick={() => void loadFromFiles()}>
          Use these files
        </button>
      </div>
      {loading && <p className="hint">{loading}...</p>}
    </>
  );
}
