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
  4.2-4.8 kHz, the same shape that the CSD singer showed. f6 is milder: 6-10 dB more at
  3.0-3.8 kHz and no dip (+6 dB at 4.2 kHz, +1 at 4.8).
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

## F4 placement (2026-11-10)

`cargo run --release -p chimera --example tract_probe -- male|female <variant>` lists the tract's
resonances per vowel with parts switched off. The high peak follows the pharynx: 15% more length
moved it down 9-12%. A narrowed epilarynx moved it further. Closing the piriform fossae left the
male peak in place, but in the female it removed the 4.75 kHz peak on /a/ outright.

The reference is the singers' speech, not their singing. LPC (5 formants under 5 kHz for men,
5.5 kHz for women) on the spoken "Row, row" excerpt puts F4 at:

- 11 men: 2.86-3.87 kHz, median 3.05. The synth measured 3.75 the same way.
- 9 women: 3.88-4.05 kHz. The synth's frames split between 4.25-4.5 and 4.75-5.25 kHz.

The singers' long tones peak lower (men 3.0-3.3, women 3.4-3.8 kHz): that is singing technique,
which the epilarynx ("ring") control models. Moving the resting anatomy to the sung peak would
count it twice.

So both adult pharynx factors grew by 1.15 (male 1.15, female 1.01; the child, with no reference
here, stays 0.8), and the resting epilarynx top went from 1.9 to 0.8 cm2, near MRI values, on
every body. The male tract is now 17.0 cm
on /a/, the female 14.4. `tests/f4_placement.rs` holds the mean F4 over a e i o u in the spoken
range (male 3.0-3.45, female 3.8-4.25 kHz) and, with the epilarynx fully narrowed, in the sung
range. Calibration then refit F1-F3 a little worse: male rms error 2.3/2.0/4.2% became
3.0/3.3/5.4%, mostly too low, since the VocalSet men's F3 (median 2.33 kHz) is lower than
Hillenbrand's.

Results, synth against singer (rms over 200 Hz-10 kHz of the harmonic level difference):

- Men's long tones: m2 13.6 -> 10.8 dB, m5 11.1 -> 9.7, m8 14.7 -> 14.2, m10 13.9 -> 12.7. Per
  1/6-octave bin (singer minus synth, mean over the vowels):
  - 3.0 kHz: the singers' excess fell by 10-12 dB on all four (m2 +26 -> +16, m5 +21 -> +11,
    m8 +11 -> +1, m10 +20 -> +8).
  - 3.36 kHz, where the synth's F4 now sits: the synth is 5-19 dB too strong for m2, m8 and m10;
    m5 still has 6 dB more than the synth.
  - 3.78 kHz: the synth's excess fell for m2 (-15 -> -9) and m10 (-16 -> -10); m8 is still -16.
  - 4.24 kHz: m5 and m10 now have 10-15 dB more than the synth; m2 went -16 -> -5.
- Women's long tones: f1 10.4 -> 9.9, f3 10.5 -> 12.8, f6 8.8 -> 10.1. The synth is now 4-25 dB
  too strong at 4.24 kHz (the 8th harmonic of C5), where the sopranos have a dip, and they have
  5-14 dB more at 4.76 kHz. Rendering the same tones with the Ring on (resting epilarynx top
  0.29 cm2) did not help: f1 10.1, f3 12.5, f6 11.0, and the 4.24 kHz excess stayed (-10, -22,
  -4). So technique is not the explanation. The female o and u keep a second, narrow resonance
  at 4.27-4.43 kHz that neither the Ring nor closing the fossae moves; what makes it is open.
- Speech: the synth's male F4 by LPC fell from 3.75 to 3.27 kHz. Its female F4 frames now
  cluster at 4.0-4.5 kHz. The 7-10 dB deficit at 1.1-2.9 kHz did not move on either body: it is
  not the tract's high resonances.

Still open:

- The speech deficit at 1-3 kHz: a source or loss question, not placement.
- Real tract bandwidths (below).

## Bandwidths: the boundary layer

Closed-glottis bandwidths of the high peaks were 11-46 Hz, and the back vowels' F3 was 12-15 Hz,
against 85-130 Hz for /a/ and /i/. Viscous loss was one resistance taken at 700 Hz, and nothing
modelled heat conduction, so the poles that radiate poorly (the rounded vowels' F3-F5, behind a
small lip opening) barely lost energy and rang as narrow, tall peaks.

Both losses now grow as sqrt(f) (`crates/chimera/src/airway/losses.rs`): viscous drag as a series
impedance in every branch, heat conduction as a conductance from every wall node to ground
(Flanagan's values). sqrt(jw) is fitted by a flat part plus three first-order sections
(corners 203, 1220 and 7801 Hz; 0.8% rms, 2.3% worst over 80 Hz-12 kHz; above that the sections
saturate near 5x the 700 Hz value, about 18 kHz). The FDTD runs them by the trapezoid rule, the
frequency solver in continuous time; `tests/airway.rs` holds the two to 5% in bandwidth.

- Male u: F3 12 -> 26 Hz, F4 14 -> 40 Hz; male /a/ F4 25 -> 47 Hz; female /a/ F4 22 -> 53 Hz.
  The high peaks fall 4-6 dB against F1 and F2. `tests/bandwidths.rs` holds every rounded vowel's
  2-5.5 kHz peaks above 22 Hz (they were 12-16).
- The formants fall 0.3-0.5% (the boundary layer's reactance); `f4_placement` still passes.
- Cost: the human male voice went from 1.00-1.05 to 1.23-1.29 ms per 128-sample block at
  oversampling 2 (+22%), 0.48 to 0.53-0.55 ms at 1 (+15%).
- Physics alone does not reach measured bandwidths (about 100 Hz at 3-4 kHz). The rest is likely
  yielding tissue and a rough, curved tract: not modelled.
- The creatures share the airway, so they changed too and were re-blessed, not re-tuned: over
  their loud windows the level moved -3.7 to +2.3 dB on average, and no call changed pitch.
- The male u keeps a strong narrow peak near 5.4 kHz. It is not the piriform fossa; its source is
  open.

## Feeding evolve

Before VocalSet can feed `chimera evolve`, the evolve problem needs:

- a voice body per singer (male or female size);
- vowel-only lyrics, taken from the file name;
- F0 resampled from the 11.61 ms hop, or tracked again.

The CSD loader in `crates/chimera-cli/src/evolve.rs` (`load_problem`, `plan`) is the place.
