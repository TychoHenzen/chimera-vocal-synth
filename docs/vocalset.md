# VocalSet as a reference

The CSD recordings are one high soprano singing songs. VocalSet adds 20 trained singers (9 women,
11 men), each singing the same exercises on the five vowels a e i o u. That gives the voice work
lower voices, both sexes, and single vowels held on one pitch. Both datasets live under
`voiceRef/`, which is gitignored: nothing from them, and nothing derived from them, goes in git.
No license file ships with either download, so check the source records before sharing anything
made from them.

`bun tools/vocalset-index.ts` joins the two parts and writes `voiceRef/vocalset-index.json`, one
entry per recording: singer, sex, context, technique, vowel, length, the annotation file (or
null), its technique label, its note count, and the median F0.

## The two downloads

`voiceRef/FULL/<singer>/<context>/<technique>/<name>.wav` holds the audio: 3613 mono 16-bit wavs
at 44.1 kHz, 8.8 hours.

- Singers: `female1`-`female9`, `male1`-`male11`.
- Contexts:
  - `arpeggios` and `scales`: belt, breathy, fast_forte, fast_piano, lip_trill, slow_forte,
    slow_piano, straight, vibrato, vocal_fry.
  - `long_tones`: forte, inhaled, messa, pp, straight, trill, trillo.
  - `excerpts`: three songs (row, caro, dona) sung straight and with vibrato, and spoken.
- Names: `<f|m><n>_<context>[_c|_f]_<technique>_<vowel>.wav`. The `_c` / `_f` part is the key
  of the exercise (C or F).

`voiceRef/Annotated VocalSet/` holds note annotations for 2688 of the recordings. It has no
annotation for vocal_fry, inhaled or pp, for most of slow_forte, or for parts of lip_trill.

## How they join

An annotation file has the same name as its wav, without `.wav`. That holds for 2683 of the 2688.
The index normalises the rest:

- The singer comes from the folder, never from the file name. Some wavs have no singer prefix,
  e.g. `female4/scales/straight/scales_straight_a.wav`. And `male8/excerpts/vibrato/` holds a file
  named `m9_caro_vibrato.wav`.
- `male8/scales/slow_forte/` spells the technique `sow_forte`. The annotations spell it
  `slow_forte`.
- `female2/arpeggios/vibrado/` is the vibrato folder.
- Three `female2` files named `...(1).wav` are byte-identical copies of the file beside them. The
  index drops them, which leaves 3610 recordings.
- `female9/arpeggios/fast_forte/arps_fast_piano_c.wav` says piano in a forte folder. It has no
  annotation, and the index keeps the folder's technique.
- `.DS_Store` and `_DS_Store` files are macOS leftovers.

Do not run `ContourPlotter.exe`: it is an executable inside a downloaded dataset, and it only
draws the plots that ship as jpgs anyway.

## What the annotation folders hold

There are four variants, `1` to `4`. Each has a `raw` folder and an `extended` folder. All four
share one F0 track. They differ only in where a pitch glide between two notes goes:

| variant | a glide between notes is |
|---|---|
| 1 | its own `Transition` segment |
| 2 | part of the next note |
| 3 | part of the previous note |
| 4 | split at its midpoint between the two notes |

I checked this by rebuilding variants 2-4 from variant 1 on 135 files. Every boundary landed
within 5 ms, and within 28 ms for the midpoint split. So variant 1 holds all the information, and
the index reads only variant 1.

- `raw N/csv/<technique>/<name>.csv` is a frame track with the columns time, F0 (0 = unvoiced),
  amplitude, onset, offset and transition. The hop is 512 samples, 11.61 ms. The evolve code
  works on a 10 ms hop, so resample any F0 taken from here. `raw N/plots/` holds a jpg of each
  contour.
- `extended N/with file header/` and `without file header/` hold the same segment table, one row
  per Rest, Sound or Transition. A Sound row has its F0 statistics, the score's note (name,
  frequency, MIDI, length), its lyric (the vowel, or a syllable in the excerpts), and its interval
  to its neighbours. The header version adds lines for gender, singer, technique, music type,
  vowel and length.
- `extended N/all files.csv` is every file's segment table in one file, with the file's metadata
  on each row: 62162 rows for variant 1.

The technique labels in the annotations are finer than the folders. The `straight` folder is
`StraightTone` or `Slow_StraightTone`, the `vibrato` folder is `MoltoVibrato` or
`Slow_MoltoVibrato`, `belt` is `Belt_Harsh`, `breathy` is `Breathy` or `VeryBreathy`, and
`forte` long tones are `FullVoice`. The index keeps both.

## What it offers the realism work

The open question from the CSD work is timbre. Above about 3 kHz the synth and the singer differ
by a fixed colouring and by a part that changes from vowel to vowel. Vowel calibration never fits
that range, since it fits only F1-F3. VocalSet tests that with less in the way:

- `long_tones/straight` and `long_tones/forte` hold every singer on every vowel at one pitch,
  without vibrato. The women sing near C5 (520-545 Hz), close to the CSD singer, and the men near
  C4 (250-270 Hz). One man, m9, sings near F4 (345-350 Hz). At C4 a man's voice puts twice as many
  harmonics under F4 and F5 as hers did, so the high formants are sampled far more finely.
- The scales and arpeggios cover C3-G4 (131-392 Hz) for the men and C4-G5 for the women, on
  every vowel.
- Breathy, belt, pp, forte and messa di voce show the same singer with a different source. That
  separates what the glottis does from what the tract does.
- The spoken excerpts give each singer's speaking voice next to the sung one.

## First comparison: straight long tones (2026-11-09)

The synth (`render notes`, no vibrato) sang each singer's five long tones at the same pitch and
length. Each voice's harmonic levels were averaged over the middle half of the note, with the
total level removed, and compared on 1/6-octave bins (scripts kept outside the repo).

- Men (m1, m2, m5, m8, m10, near 260 Hz): every singer has 11-26 dB more than the synth between
  1.9 and 3.4 kHz, and up to 19 dB less at 3.8-4.8 kHz. The gap is 11-15 dB rms over 0.2-10 kHz,
  9-12 of it the same on every vowel.
- Women (f1, f3, near 530 Hz): 15-23 dB more than the synth at 3.4-3.8 kHz and a dip at
  4.2-4.8 kHz, the same shape the CSD singer showed.
- The engine's tract (the `transfer` call the UI draws, neutral epilarynx) has a resonance pair
  that hardly moves with the vowel: 3.7-4.0 kHz in the male body, 4.7-4.9 kHz in the female. It
  is often the strongest peak of the whole transfer function, F1 included. It sits about 25-30%
  above where the singers' energy peaks. Narrowing the epilarynx fully, or lowering the larynx to
  -1.3, pulls the male peak to 3.2-3.4 kHz. The epilarynx gene of 8b0e971 did not create it.
- Speech: seven men speaking the "Row, row, row your boat" excerpt have 7-11 dB more than the
  synth's male `render text` between 1.1 and 2.9 kHz (speaker spread 3-5 dB), and about the same
  at 4.5-5.7 kHz. So the mid-band deficit is not only classical technique.
- The per-vowel residuals at 1-2 kHz are large on all five vowels: sung vowels are not the spoken
  American vowels of Hillenbrand that calibration fits.

Vowel calibration fits F1-F3 only, so nothing ever places F4 and above, or how strong they are.

## Feeding evolve

Before VocalSet can feed `chimera evolve`, the evolve problem needs:

- a voice body per singer (male or female size);
- vowel-only lyrics, taken from the file name;
- F0 resampled from the 11.61 ms hop, or tracked again.

The CSD loader in `crates/chimera-cli/src/evolve.rs` (`load_problem`, `plan`) is the place.
