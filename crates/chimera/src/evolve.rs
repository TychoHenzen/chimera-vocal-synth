//! Tune the synthesiser to a recording with an evolution strategy. Shared by `chimera evolve`
//! (native, threads) and the web app's Evolve mode (wasm, one worker per core); nothing here
//! touches files or threads.
//!
//! A genome is a vector in [0,1]. It decodes to every knob we can reach: the glottal source
//! (`VoiceTuning`), lung pressure and tension, vibrato, the body dimensions, an offset on every
//! vowel articulator, and per note a timing shift, a length change, a pitch error and which vowel
//! is sung (the recording's vowel, or any other). The score is how far the rendered spectrogram is
//! from the recording's, in log-mel dB at two time/frequency resolutions plus the frame-to-frame
//! change and the loudness contour. The optimiser is a separable CMA-ES (one variance per gene).

use crate::analysis::fft::{Fft, hann};
use crate::anatomy::human::{ArticKey, HumanBody};
use crate::csd::Note;
use crate::math::{js_round, midi_to_hz};
use crate::phonetics::Segment;
use crate::phonetics::sing::{SongOptions, SungNote, plan_song};
use crate::phonetics::vowel_data::VOWELS;
use crate::voice::human_voice::{HumanVoice, SourcePatch, VoiceTuning};
use serde::{Deserialize, Serialize};

/// Output rate of every render.
pub const FS: f64 = 48000.0;
pub const BANDS: usize = 64;
const MEL_LO: f64 = 50.0;
const MEL_HI: f64 = 10000.0;
/// Quietest level kept, below the recording's peak (dB).
pub const FLOOR_DB: f64 = 80.0;
pub const PAD_BEFORE: f64 = 0.4;
pub const PAD_AFTER: f64 = 0.5;
const VIBRATO_DEFAULT: f64 = 35.0;

/// The vowels a note may be re-sung as.
const VOWEL_CHOICES: [&str; 13] = ["i", "ɪ", "e", "ɛ", "æ", "a", "ɑ", "ɔ", "o", "ʊ", "u", "ʌ", "ə"];
/// Articulators whose vowel targets get an evolved offset.
/// Only keys the vowel targets actually carry: an offset on a key a target lacks is never applied
/// (velum, epilarynx and dorsum were inert genes here before; epilarynx now has its own gene).
const ARTIC_OFFSETS: [ArticKey; 8] = [
    ArticKey::Jaw,
    ArticKey::TbX,
    ArticKey::TbY,
    ArticKey::Root,
    ArticKey::LipAp,
    ArticKey::LipProt,
    ArticKey::LipWidth,
    ArticKey::Larynx,
];

// ---------------------------------------------------------------------------------------------
// genome

#[derive(Clone, Debug, Serialize)]
pub struct Gene {
    pub name: String,
    pub lo: f64,
    pub hi: f64,
    pub def: f64,
}

#[derive(Clone, Debug)]
pub struct Spec {
    pub genes: Vec<Gene>,
    pub n_notes: usize,
}

const G_CHINK: usize = 0;
const G_OQ: usize = 1;
const G_SKEW: usize = 2;
const G_SHARP: usize = 3;
const G_JITTER: usize = 4;
const G_SHIMMER: usize = 5;
const G_SMOOTH: usize = 6;
const G_WAVEGAIN: usize = 7;
const G_PRESSURE_SCALE: usize = 8;
const G_GAIN: usize = 9;
const G_PRESSURE: usize = 10;
const G_TENSION: usize = 11;
const G_VIBRATO: usize = 12;
const G_TIME: usize = 13;
const G_SCALE: usize = 14;
const G_PHARYNX: usize = 15;
const G_TONGUE: usize = 16;
const G_LIP: usize = 17;
/// Loudness shape shared by every note, in dB at the note's start, middle and end.
const G_DYN_START: usize = 18;
const G_DYN_MID: usize = 19;
const G_DYN_END: usize = 20;
/// Loudness wobble: peak depth (dB) and rate (Hz), faded in over the first part of each note.
const G_TREM_DB: usize = 21;
const G_TREM_HZ: usize = 22;
/// Source settings the song planner leaves at the voice's defaults.
const G_BREATH: usize = 23;
const G_ROUGH: usize = 24;
const G_FRY: usize = 25;
const G_VRATE: usize = 26;
const G_DRIFT: usize = 27;
const G_GLIDE: usize = 28;
const G_BRIGHT: usize = 29;
const G_VISC: usize = 30;
const G_WALL: usize = 31;
const G_ASPIRATION: usize = 32;
/// Upper edge of the aspiration noise band (Hz).
const G_ASP_HZ: usize = 33;
/// How far the epilarynx tube above the folds is narrowed on every vowel (0 wide, 1 narrowest).
/// A narrow tube opening into a wide pharynx rings near 3-4 kHz (the singer's-formant cluster).
const G_EPI: usize = 34;
const G_ARTIC: usize = 35;
const G_NOTES: usize = G_ARTIC + ARTIC_OFFSETS.len();
const PER_NOTE: usize = 5;
/// Seconds over which each note's wobble grows from nothing.
const TREM_ONSET: f64 = 0.3;

impl Spec {
    pub fn new(n_notes: usize) -> Spec {
        let mut genes = Vec::new();
        let mut g = |name: &str, lo: f64, hi: f64, def: f64| {
            genes.push(Gene { name: name.into(), lo, hi, def });
        };
        g("chink_scale", 0.2, 3.0, 1.0);
        g("open_quotient_add", -0.25, 0.25, 0.0);
        g("skew_add", -0.2, 0.3, 0.0);
        g("sharpness_add", -0.5, 0.5, 0.0);
        g("jitter_scale", 0.0, 3.0, 1.0);
        g("shimmer_scale", 0.0, 3.0, 1.0);
        g("smooth_wave", 0.0, 1.0, 0.0);
        g("wave_gain", 0.5, 4.0, 1.0);
        g("pressure_scale", 0.5, 3.0, 1.0);
        // the score compares absolute levels, so this must reach the recording's loudness
        g("gain_db", -36.0, 24.0, 0.0);
        g("lung_pressure", 4.0, 16.0, 9.0);
        g("tension", 0.2, 0.9, 0.55);
        g("vibrato_cents", 0.0, 80.0, VIBRATO_DEFAULT);
        g("time_shift_s", -0.08, 0.08, 0.0);
        g("body_scale", 0.8, 1.0, 0.9);
        // BODY_FEMALE's pharynx (1.01 since F4 was matched to the VocalSet singers' speech)
        g("body_pharynx", 0.85, 1.15, crate::anatomy::human::BODY_FEMALE.pharynx);
        g("body_tongue_radius", 1.8, 2.6, 2.2);
        g("body_lip_width", 3.6, 5.0, 4.4);
        g("dyn_start_db", -24.0, 6.0, 0.0);
        g("dyn_mid_db", -12.0, 12.0, 0.0);
        g("dyn_end_db", -24.0, 6.0, 0.0);
        g("tremolo_db", 0.0, 8.0, 0.0);
        g("tremolo_hz", 3.5, 8.0, 5.5);
        g("breathiness", 0.0, 0.7, 0.15);
        g("roughness", 0.0, 0.6, 0.1);
        g("fry", 0.0, 0.4, 0.0);
        g("vibrato_rate_hz", 4.0, 8.0, 6.0);
        g("pitch_drift", 0.0, 20.0, 5.0);
        g("pitch_glide_s", 0.01, 0.25, 0.06);
        g("brightness", 0.0, 1.0, 0.25);
        g("viscous_scale", 0.2, 15.0, 1.0);
        g("wall_damping_scale", 0.2, 6.0, 1.0);
        g("aspiration_scale", 0.2, 8.0, 1.0);
        g("aspiration_hz", 2500.0, 9000.0, crate::voice::human_airway::ASPIRATION_HZ);
        g("epilarynx", 0.0, 0.95, 0.0);
        for k in ARTIC_OFFSETS {
            g(&format!("vowel_{}", k.name()), -0.2, 0.2, 0.0);
        }
        for i in 0..n_notes {
            g(&format!("n{i}_shift_s"), -0.12, 0.12, 0.0);
            g(&format!("n{i}_dur_s"), -0.12, 0.12, 0.0);
            g(&format!("n{i}_cents"), -60.0, 60.0, 0.0);
            // below 0.5 the recording's vowel; above, one of VOWEL_CHOICES
            g(&format!("n{i}_vowel"), 0.0, 1.0, 0.25);
            g(&format!("n{i}_level_db"), -15.0, 15.0, 0.0);
        }
        Spec { genes, n_notes }
    }

    /// How many genes come before the per-note ones: the voice, which carries over to any song.
    pub fn n_global() -> usize {
        G_NOTES
    }

    pub fn dim(&self) -> usize {
        self.genes.len()
    }

    /// The default voice as a genome.
    pub fn start(&self) -> Vec<f64> {
        self.genes.iter().map(|g| (g.def - g.lo) / (g.hi - g.lo)).collect()
    }

    pub fn decode(&self, x: &[f64]) -> Vec<f64> {
        self.genes.iter().zip(x).map(|(g, &u)| g.lo + u.clamp(0.0, 1.0) * (g.hi - g.lo)).collect()
    }

    /// The vowel each note is sung with for a genome (`None`: the recording's own).
    pub fn sung_vowels(&self, x: &[f64]) -> Vec<Option<&'static str>> {
        let v = self.decode(x);
        (0..self.n_notes)
            .map(|k| {
                let b = G_NOTES + k * PER_NOTE;
                (v[b + 3] >= 0.5).then(|| vowel_choice(v[b + 3]))
            })
            .collect()
    }
}

fn vowel_choice(v: f64) -> &'static str {
    let i = (((v - 0.5) * 2.0) * VOWEL_CHOICES.len() as f64) as usize;
    VOWEL_CHOICES[i.min(VOWEL_CHOICES.len() - 1)]
}

fn is_vowel_label(s: &str) -> bool {
    VOWELS.iter().any(|v| v.ipa == s)
}

// ---------------------------------------------------------------------------------------------
// rendering

/// Hop (s) of the recording's pitch contour.
const F0_HOP: f64 = 0.01;

/// The recording's pitch (Hz every `F0_HOP` s from the clip start, 0 where unvoiced or doubtful).
/// A reading more than 350 cents from the note sung there is an octave slip or a consonant and is
/// dropped, then a 5-frame median removes isolated jumps. The render follows this contour, so the
/// score no longer has to match harmonics that sit a whole mel band away at 3-4 kHz.
pub fn f0_contour(x: &[f64], rate: f64, notes: &[Note]) -> Vec<f64> {
    let n = (0.05 * rate) as usize;
    let hop = (F0_HOP * rate) as usize;
    if x.len() < 2 * n || hop == 0 {
        return Vec::new();
    }
    let opts = crate::analysis::pitch::YinOpts { min_f0: Some(120.0), max_f0: Some(1200.0), threshold: Some(0.2) };
    let frames = (x.len() - n) / hop;
    let mut raw = vec![0.0f64; frames + 3];
    for j in 0..frames {
        let t = (j * hop + n / 2) as f64 / rate;
        let hz = crate::analysis::pitch::yin_pitch(&x[j * hop..j * hop + n], rate, opts).f0;
        if hz <= 0.0 {
            continue;
        }
        let near = notes.iter().find(|nt| t >= nt.start - 0.1 && t <= nt.end + 0.1);
        if let Some(nt) = near {
            let cents = 1200.0 * (hz / midi_to_hz(nt.midi)).log2();
            if cents.abs() > 350.0 {
                continue;
            }
        }
        // the frame is centred 2.5 hops after its start
        raw[((t / F0_HOP).round() as usize).min(frames + 2)] = hz;
    }
    let mut out = raw.clone();
    for i in 2..raw.len().saturating_sub(2) {
        let mut w: Vec<f64> = raw[i - 2..=i + 2].to_vec();
        if w.iter().filter(|&&h| h > 0.0).count() < 3 {
            out[i] = 0.0;
            continue;
        }
        w.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        out[i] = w[2];
    }
    // Estimates wobble by about a percent frame to frame; a render that follows that wobble has
    // smeared high harmonics. A short Gaussian (sigma 2 frames = 20 ms) keeps vibrato (6 Hz) and
    // removes the estimator's noise. Averaged in the log domain over voiced neighbours only.
    let mut smooth = out.clone();
    for i in 0..out.len() {
        if out[i] <= 0.0 {
            continue;
        }
        let (mut s, mut w) = (0.0, 0.0);
        for d in -5i32..=5 {
            let j = i as i32 + d;
            if j < 0 || j as usize >= out.len() || out[j as usize] <= 0.0 {
                continue;
            }
            let k = (-(d * d) as f64 / 8.0).exp();
            s += k * out[j as usize].ln();
            w += k;
        }
        smooth[i] = (s / w).exp();
    }
    smooth
}

/// Sing `notes` (on the clip's own timeline) with the decoded values `v`. A non-empty `f0`
/// (see `f0_contour`) is followed instead of the notes' pitch.
fn render(notes: &[Note], v: &[f64], seconds: f64, f0: &[f64]) -> Vec<f32> {
    let body = HumanBody {
        name: "evolved",
        scale: v[G_SCALE],
        pharynx: v[G_PHARYNX],
        tongue_radius: v[G_TONGUE],
        lip_width: v[G_LIP],
    };
    let mut voice = HumanVoice::new(FS, body, 2);
    voice.set_tuning(VoiceTuning {
        chink_scale: v[G_CHINK],
        open_quotient_add: v[G_OQ],
        skew_add: v[G_SKEW],
        sharpness_add: v[G_SHARP],
        jitter_scale: v[G_JITTER],
        shimmer_scale: v[G_SHIMMER],
        smooth_wave: v[G_SMOOTH],
        wave_gain: v[G_WAVEGAIN],
        pressure_scale: v[G_PRESSURE_SCALE],
        gain_db: v[G_GAIN],
        viscous_scale: v[G_VISC],
        wall_damping_scale: v[G_WALL],
        aspiration_scale: v[G_ASPIRATION],
        aspiration_hz: v[G_ASP_HZ],
    });
    voice.set_source(&SourcePatch {
        f0: Some(midi_to_hz(notes[0].midi)),
        voiced: Some(true),
        pressure: Some(v[G_PRESSURE]),
        tension: Some(v[G_TENSION]),
        breathiness: Some(v[G_BREATH]),
        roughness: Some(v[G_ROUGH]),
        fry: Some(v[G_FRY]),
        vibrato_rate: Some(v[G_VRATE]),
        // the measured contour already carries drift and vibrato
        drift: Some(if f0.is_empty() { v[G_DRIFT] } else { 0.0 }),
        glide: Some(v[G_GLIDE]),
        brightness: Some(v[G_BRIGHT]),
        ..Default::default()
    });

    let mut ns: Vec<Note> = notes.to_vec();
    for (k, n) in ns.iter_mut().enumerate() {
        let b = G_NOTES + k * PER_NOTE;
        n.start += v[b];
        n.end += v[b] + v[b + 1];
        n.midi += v[b + 2] / 100.0;
        if v[b + 3] >= 0.5 {
            let ipa = vowel_choice(v[b + 3]);
            if ipa != n.syl.nucleus.ipa {
                n.syl.nucleus = Segment::new(ipa);
            }
        }
    }
    for k in 0..ns.len() {
        if k + 1 < ns.len() && ns[k + 1].start < ns[k].start + 0.05 {
            ns[k + 1].start = ns[k].start + 0.05;
        }
        if ns[k].end < ns[k].start + 0.05 {
            ns[k].end = ns[k].start + 0.05;
        }
    }

    let mut i = 0;
    while i < ns.len() {
        let mut j = i;
        while j + 1 < ns.len() && !ns[j].syl.phrase_end {
            j += 1;
        }
        let sung: Vec<SungNote> = (i..=j)
            .map(|k| SungNote {
                midi: ns[k].midi,
                beats: if k < j { ns[k + 1].start - ns[k].start } else { ns[k].end - ns[k].start },
                syl: ns[k].syl.clone(),
            })
            .collect();
        let mut plan = plan_song(
            &sung,
            &SongOptions { body: "female".into(), bpm: 60.0, t0: (ns[i].start + v[G_TIME]).max(0.0), vibrato: if f0.is_empty() { v[G_VIBRATO] } else { 0.0 } },
        );
        for g in plan.gestures.iter_mut() {
            if g.strength >= 0.999 && g.label.is_some_and(|l| is_vowel_label(l.as_str())) {
                for (ki, k) in ARTIC_OFFSETS.iter().enumerate() {
                    if let Some(t) = g.targets.get(*k) {
                        g.targets.set(*k, t + v[G_ARTIC + ki]);
                    }
                }
                // ASSUMPTION: the vowel targets never set the epilarynx, so this is an absolute
                // value held through every vowel; consonants keep the wide default.
                let base = g.targets.get(ArticKey::Epilarynx).unwrap_or(0.0);
                g.targets.set(ArticKey::Epilarynx, (base + v[G_EPI]).clamp(0.0, 1.0));
            }
        }
        voice.schedule(&plan.gestures);
        i = j + 1;
    }
    if !f0.is_empty() {
        voice.set_f0_track(F0_HOP, f0.to_vec());
    }
    let mut out = vec![0f32; js_round(FS * seconds) as usize];
    for block in out.chunks_mut(128) {
        voice.render(block);
    }
    apply_dynamics(&mut out, &ns, v);
    out
}

/// Shape the loudness over time: the model sings every note at one steady level, a singer swells
/// and fades inside each note and wobbles. A gain curve (dB, piecewise linear through each
/// note's start, middle and end) and a tremolo are applied to the finished render.
/// ASSUMPTION: a post gain stands in for varying the lung pressure per note, which changes the
/// timbre too; it is cheaper and keeps the voice's own onsets. Neutral at the default genes.
fn apply_dynamics(out: &mut [f32], ns: &[Note], v: &[f64]) {
    let mut knots: Vec<(f64, f64)> = Vec::with_capacity(ns.len() * 3);
    let mut starts: Vec<f64> = Vec::with_capacity(ns.len());
    for (k, n) in ns.iter().enumerate() {
        let level = v[G_NOTES + k * PER_NOTE + 4];
        let (ts, te) = (n.start + v[G_TIME], n.end + v[G_TIME]);
        starts.push(ts);
        knots.push((ts, v[G_DYN_START] + level));
        knots.push(((ts + te) * 0.5, v[G_DYN_MID] + level));
        knots.push((te, v[G_DYN_END] + level));
    }
    knots.sort_by(|a, b| a.0.total_cmp(&b.0));
    if knots.iter().all(|k| k.1 == 0.0) && v[G_TREM_DB] == 0.0 {
        return;
    }
    let ln10_20 = std::f64::consts::LN_10 / 20.0;
    let (mut seg, mut note) = (0usize, 0usize);
    for (i, s) in out.iter_mut().enumerate() {
        let t = i as f64 / FS;
        while seg + 1 < knots.len() && knots[seg + 1].0 <= t {
            seg += 1;
        }
        let mut db = if t <= knots[0].0 {
            knots[0].1
        } else if seg + 1 >= knots.len() {
            knots[knots.len() - 1].1
        } else {
            let (a, b) = (knots[seg], knots[seg + 1]);
            a.1 + (b.1 - a.1) * ((t - a.0) / (b.0 - a.0).max(1e-9))
        };
        while note + 1 < starts.len() && starts[note + 1] <= t {
            note += 1;
        }
        if v[G_TREM_DB] > 0.0 && t >= starts[note] {
            let ramp = ((t - starts[note]) / TREM_ONSET).min(1.0);
            db += v[G_TREM_DB] * ramp * (std::f64::consts::TAU * v[G_TREM_HZ] * t).sin();
        }
        *s *= (db * ln10_20).exp() as f32;
    }
}

// ---------------------------------------------------------------------------------------------
// spectrogram loss

struct Mel {
    n: usize,
    hop: usize,
    fft: Fft,
    window: Vec<f64>,
    /// per band: first bin and weights
    bank: Vec<(usize, Vec<f64>)>,
}

fn hz_to_mel(f: f64) -> f64 {
    2595.0 * (1.0 + f / 700.0).log10()
}
fn mel_to_hz(m: f64) -> f64 {
    700.0 * (10f64.powf(m / 2595.0) - 1.0)
}

impl Mel {
    fn new(n: usize, hop: usize) -> Mel {
        let bins = n / 2 + 1;
        let (lo, hi) = (hz_to_mel(MEL_LO), hz_to_mel(MEL_HI));
        let edges: Vec<f64> =
            (0..BANDS + 2).map(|i| mel_to_hz(lo + (hi - lo) * i as f64 / (BANDS + 1) as f64)).collect();
        let bin_hz = FS / n as f64;
        let mut bank = Vec::with_capacity(BANDS);
        for b in 0..BANDS {
            let (f0, f1, f2) = (edges[b], edges[b + 1], edges[b + 2]);
            let first = ((f0 / bin_hz).floor() as usize).min(bins - 1);
            let last = ((f2 / bin_hz).ceil() as usize).min(bins - 1);
            let mut w = Vec::new();
            for k in first..=last {
                let f = k as f64 * bin_hz;
                let t = if f <= f1 { (f - f0) / (f1 - f0) } else { (f2 - f) / (f2 - f1) };
                w.push(t.max(0.0));
            }
            let s: f64 = w.iter().sum();
            if s > 0.0 {
                for x in w.iter_mut() {
                    *x /= s;
                }
            } else {
                w = vec![1.0];
            }
            bank.push((first, w));
        }
        Mel { n, hop, fft: Fft::new(n), window: hann(n), bank }
    }

    fn frames(&self, len: usize) -> usize {
        if len < self.n { 0 } else { (len - self.n) / self.hop + 1 }
    }

    /// Log-mel power in dB, frame-major (`frames * BANDS`).
    fn log_mel(&self, x: &[f64]) -> Vec<f64> {
        let nf = self.frames(x.len());
        let mut out = Vec::with_capacity(nf * BANDS);
        let mut re = vec![0.0; self.n];
        let mut im = vec![0.0; self.n];
        for f in 0..nf {
            let s = f * self.hop;
            for i in 0..self.n {
                re[i] = x[s + i] * self.window[i];
                im[i] = 0.0;
            }
            self.fft.transform(&mut re, &mut im);
            for (first, w) in &self.bank {
                let mut p = 0.0;
                for (j, wj) in w.iter().enumerate() {
                    let k = first + j;
                    p += wj * (re[k] * re[k] + im[k] * im[k]);
                }
                out.push(10.0 * (p + 1e-12).log10());
            }
        }
        out
    }
}

pub const N_COMP: usize = 5;
pub const COMP_NAMES: [&str; N_COMP] = ["mel2048", "mel512", "flux", "envelope", "spectrum"];
pub const COMP_WEIGHTS: [f64; N_COMP] = [1.0, 1.0, 0.5, 0.5, 3.0];

/// Long-term spectrum: each band's power averaged over the frames, in dB. Frame-by-frame errors in
/// harmonic detail average out; a whole band that is too quiet (a missing 3-4 kHz body) does not.
fn long_term(m: &[f64]) -> Vec<f64> {
    let nf = (m.len() / BANDS).max(1);
    (0..BANDS)
        .map(|b| {
            let p: f64 = (0..nf).map(|f| 10f64.powf(m[f * BANDS + b] / 10.0)).sum::<f64>() / nf as f64;
            10.0 * (p + 1e-12).log10()
        })
        .collect()
}

fn mean(v: &[f64]) -> f64 {
    if v.is_empty() { 0.0 } else { v.iter().sum::<f64>() / v.len() as f64 }
}

fn l1(a: &[f64], b: &[f64]) -> f64 {
    let n = a.len().min(b.len());
    if n == 0 {
        return 100.0;
    }
    (0..n).map(|i| (a[i] - b[i]).abs()).sum::<f64>() / n as f64
}

/// Per-frame change across bands (how the spectrum moves, which level-matching hides).
fn flux(m: &[f64]) -> Vec<f64> {
    let nf = m.len() / BANDS;
    let mut o = Vec::with_capacity(nf.saturating_sub(1) * BANDS);
    for f in 1..nf {
        for b in 0..BANDS {
            o.push(m[f * BANDS + b] - m[(f - 1) * BANDS + b]);
        }
    }
    o
}

/// Loudness contour: log of the summed band power per frame.
fn envelope(m: &[f64]) -> Vec<f64> {
    m.chunks(BANDS)
        .map(|fr| {
            let p: f64 = fr.iter().map(|d| 10f64.powf(d / 10.0)).sum();
            10.0 * (p + 1e-12).log10()
        })
        .collect()
}

/// Mono samples of `[t0, t0 + seconds)` of a recording at the engine's rate.
pub fn cut(x: &[f64], rate: f64, t0: f64, seconds: f64) -> Vec<f64> {
    let n = (seconds * FS).round() as usize;
    (0..n)
        .map(|i| {
            let p = (t0 + i as f64 / FS) * rate;
            if p < 0.0 {
                return 0.0;
            }
            let k = p.floor() as usize;
            let fr = p - k as f64;
            let a = x.get(k).copied().unwrap_or(0.0);
            let b = x.get(k + 1).copied().unwrap_or(0.0);
            a + (b - a) * fr
        })
        .collect()
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct Eval {
    pub loss: f64,
    pub comps: [f64; N_COMP],
    /// mean level of the render minus the recording's (dB, log-mel above the floor); part of the score
    pub gap: f64,
}

/// One recording and its notes: everything an evaluation needs.
pub struct Problem {
    pub spec: Spec,
    /// the clip's notes, on the clip's own timeline
    pub notes: Vec<Note>,
    pub seconds: f64,
    /// start of the clip in the recording (s)
    pub clip0: f64,
    reference: Vec<f64>,
    /// the recording's pitch contour, followed by every render (empty: sing the notes' pitch)
    pub f0_track: Vec<f64>,
    coarse: Mel,
    fine: Mel,
    ref_coarse: Vec<f64>,
    ref_fine: Vec<f64>,
    floor_coarse: f64,
    floor_fine: f64,
}

impl Problem {
    /// Notes `first..=last` of `all`, against the recording `wav` (mono, `rate` Hz) whose first
    /// sample is at `wav_t0` seconds into the song (0 for the whole recording).
    pub fn new(all: &[Note], first: usize, last: usize, wav: &[f64], rate: f64, wav_t0: f64) -> Result<Problem, String> {
        if all.is_empty() || last >= all.len() || first > last {
            return Err(format!("{} notes; notes {first}-{last} is out of range", all.len()));
        }
        // the clip stops short of the neighbouring notes, so it does not begin or end inside
        // an utterance the notes do not describe
        let lower = all[first].prev_end + 0.03;
        let clip0 = (all[first].start - PAD_BEFORE).max(lower).min(all[first].start - 0.05).max(0.0);
        let mut clip1 = all[last].end + PAD_AFTER;
        if let Some(next) = all.get(last + 1) {
            clip1 = clip1.min((next.start - 0.03).max(all[last].end + 0.05));
        }
        let seconds = clip1 - clip0;
        let reference = cut(wav, rate, clip0 - wav_t0, seconds);
        let mut notes: Vec<Note> = all[first..=last].to_vec();
        for n in notes.iter_mut() {
            n.start -= clip0;
            n.end -= clip0;
            n.prev_end -= clip0;
        }
        if let Some(l) = notes.last_mut() {
            l.syl.phrase_end = true;
        }
        notes[0].phrase_start = true;
        let coarse = Mel::new(2048, 512);
        let fine = Mel::new(512, 128);
        let ref_coarse = coarse.log_mel(&reference);
        let ref_fine = fine.log_mel(&reference);
        let peak = |m: &[f64]| m.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        let (floor_coarse, floor_fine) = (peak(&ref_coarse) - FLOOR_DB, peak(&ref_fine) - FLOOR_DB);
        let spec = Spec::new(notes.len());
        // `cut` resamples to the engine rate, so that is the reference's rate here
        let f0_track = f0_contour(&reference, FS, &notes);
        Ok(Problem { spec, notes, seconds, clip0, reference, f0_track, coarse, fine, ref_coarse, ref_fine, floor_coarse, floor_fine })
    }

    pub fn reference(&self) -> &[f64] {
        &self.reference
    }

    pub fn render(&self, x: &[f64]) -> Vec<f32> {
        render(&self.notes, &self.spec.decode(x), self.seconds, &self.f0_track)
    }

    pub fn evaluate(&self, x: &[f64]) -> Eval {
        self.score(&self.render(x))
    }

    fn score(&self, out: &[f32]) -> Eval {
        let xs: Vec<f64> = out.iter().map(|&s| s as f64).collect();
        if xs.iter().any(|s| !s.is_finite()) {
            return Eval { loss: 1e3, comps: [1e3; N_COMP], gap: 0.0 };
        }
        let mut comps = [0.0; N_COMP];
        let mut gap = 0.0;
        for (res, (mel, r, floor)) in
            [(&self.coarse, &self.ref_coarse, self.floor_coarse), (&self.fine, &self.ref_fine, self.floor_fine)]
                .into_iter()
                .enumerate()
        {
            let mut s = mel.log_mel(&xs);
            let rc: Vec<f64> = r.iter().map(|&v| v.max(floor)).collect();
            // absolute levels: a render that is too quiet or too loud is wrong, not just coloured
            for v in s.iter_mut() {
                *v = v.max(floor);
            }
            if res == 0 {
                gap = mean(&s) - mean(&rc);
            }
            let d = 10.0;
            if res == 0 {
                comps[0] = l1(&s, &rc) / d;
                comps[4] = l1(&long_term(&s), &long_term(&rc)) / d;
            } else {
                comps[1] = l1(&s, &rc) / d;
                comps[2] = l1(&flux(&s), &flux(&rc)) / d;
                comps[3] = l1(&envelope(&s), &envelope(&rc)) / d;
            }
        }
        let loss = comps.iter().zip(COMP_WEIGHTS).map(|(a, w)| a * w).sum();
        Eval { loss, comps, gap }
    }

    /// The coarse log-mel of a render and of the recording, level-matched and scaled to 0..=255
    /// (frame-major, `BANDS` per frame), for drawing.
    pub fn pictures(&self, out: &[f32]) -> (Vec<u8>, Vec<u8>) {
        let xs: Vec<f64> = out.iter().map(|&s| s as f64).collect();
        let mut s = self.coarse.log_mel(&xs);
        let rc: Vec<f64> = self.ref_coarse.iter().map(|&v| v.max(self.floor_coarse)).collect();
        for v in s.iter_mut() {
            *v = v.max(self.floor_coarse);
        }
        let q = |m: &[f64]| -> Vec<u8> {
            m.iter().map(|&v| (((v - self.floor_coarse) / FLOOR_DB).clamp(0.0, 1.0) * 255.0) as u8).collect()
        };
        (q(&s), q(&rc))
    }
}

// ---------------------------------------------------------------------------------------------
// separable CMA-ES

/// A small seeded generator (splitmix64).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Rng(pub u64);
impl Rng {
    pub fn new(seed: u64) -> Rng {
        Rng(seed.wrapping_mul(0x2545_F491_4F6C_DD1D) | 1)
    }
    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn uniform(&mut self) -> f64 {
        ((self.next_u64() >> 11) as f64 + 0.5) / (1u64 << 53) as f64
    }
    fn normal(&mut self) -> f64 {
        let (a, b) = (self.uniform(), self.uniform());
        (-2.0 * a.ln()).sqrt() * (std::f64::consts::TAU * b).cos()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Cma {
    n: usize,
    lambda: usize,
    mu: usize,
    w: Vec<f64>,
    mueff: f64,
    cs: f64,
    damps: f64,
    cc: f64,
    c1: f64,
    cmu: f64,
    chi_n: f64,
    pub mean: Vec<f64>,
    pub sigma: f64,
    c: Vec<f64>,
    ps: Vec<f64>,
    pc: Vec<f64>,
    pub generation: usize,
    rng: Rng,
    /// Fixed per-gene step multiplier (1 = full step). A gene with a small scale moves slowly and
    /// its spread is capped at `sigma * scale`, so it cannot absorb what the fast genes should.
    #[serde(default)]
    scale: Vec<f64>,
    /// steps of the candidates last asked for
    #[serde(skip)]
    pending: Vec<Vec<f64>>,
}

impl Cma {
    pub fn new(start: Vec<f64>, sigma: f64, lambda: usize, seed: u64) -> Cma {
        let n = start.len();
        Cma::with_scales(start, sigma, lambda, seed, vec![1.0; n])
    }

    /// Like `new`, with a per-gene step multiplier (see the `scale` field).
    pub fn with_scales(start: Vec<f64>, sigma: f64, lambda: usize, seed: u64, scale: Vec<f64>) -> Cma {
        let n = start.len();
        assert_eq!(scale.len(), n, "one scale per gene");
        let nf = n as f64;
        let mu = lambda / 2;
        let mut w: Vec<f64> = (0..mu).map(|i| ((mu as f64) + 0.5).ln() - ((i + 1) as f64).ln()).collect();
        let s: f64 = w.iter().sum();
        for x in w.iter_mut() {
            *x /= s;
        }
        let mueff = 1.0 / w.iter().map(|x| x * x).sum::<f64>();
        let cs = (mueff + 2.0) / (nf + mueff + 5.0);
        let damps = 1.0 + 2.0 * (((mueff - 1.0) / (nf + 1.0)).sqrt() - 1.0).max(0.0) + cs;
        let cc = (4.0 + mueff / nf) / (nf + 4.0 + 2.0 * mueff / nf);
        let sep = (nf + 2.0) / 3.0;
        let c1 = (2.0 / ((nf + 1.3).powi(2) + mueff) * sep).min(0.5);
        let cmu = (2.0 * (mueff - 2.0 + 1.0 / mueff) / ((nf + 2.0).powi(2) + mueff) * sep).min(1.0 - c1);
        let chi_n = nf.sqrt() * (1.0 - 1.0 / (4.0 * nf) + 1.0 / (21.0 * nf * nf));
        Cma {
            n,
            lambda,
            mu,
            w,
            mueff,
            cs,
            damps,
            cc,
            c1,
            cmu,
            chi_n,
            mean: start,
            sigma,
            c: vec![1.0; n],
            ps: vec![0.0; n],
            pc: vec![0.0; n],
            generation: 0,
            rng: Rng::new(seed),
            scale,
            pending: Vec::new(),
        }
    }

    fn scale_of(&self, i: usize) -> f64 {
        self.scale.get(i).copied().unwrap_or(1.0)
    }

    /// The next generation's candidates, clamped to [0,1].
    pub fn ask(&mut self) -> Vec<Vec<f64>> {
        let mut xs = Vec::with_capacity(self.lambda);
        self.pending.clear();
        for _ in 0..self.lambda {
            let mut x = vec![0.0; self.n];
            let mut y = vec![0.0; self.n];
            for i in 0..self.n {
                let step = self.sigma * self.scale_of(i);
                let raw = self.mean[i] + step * self.c[i].sqrt() * self.rng.normal();
                x[i] = raw.clamp(0.0, 1.0);
                y[i] = (x[i] - self.mean[i]) / step;
            }
            xs.push(x);
            self.pending.push(y);
        }
        xs
    }

    /// Rank the candidates last asked for by their losses and move.
    pub fn tell(&mut self, losses: &[f64]) {
        let ys = std::mem::take(&mut self.pending);
        assert_eq!(ys.len(), losses.len(), "tell: losses for a different generation");
        let mut order: Vec<usize> = (0..ys.len()).collect();
        order.sort_by(|&a, &b| losses[a].partial_cmp(&losses[b]).unwrap_or(std::cmp::Ordering::Equal));
        let n = self.n;
        let mut ymean = vec![0.0; n];
        for (r, &idx) in order.iter().take(self.mu).enumerate() {
            for i in 0..n {
                ymean[i] += self.w[r] * ys[idx][i];
            }
        }
        for i in 0..n {
            self.mean[i] = (self.mean[i] + self.sigma * self.scale_of(i) * ymean[i]).clamp(0.0, 1.0);
        }
        let k = (self.cs * (2.0 - self.cs) * self.mueff).sqrt();
        for i in 0..n {
            self.ps[i] = (1.0 - self.cs) * self.ps[i] + k * ymean[i] / self.c[i].sqrt();
        }
        let psn = self.ps.iter().map(|x| x * x).sum::<f64>().sqrt();
        let decay = (1.0f64 - (1.0f64 - self.cs).powi(2 * (self.generation as i32 + 1))).sqrt();
        let hsig = psn / decay / self.chi_n < 1.4 + 2.0 / (self.n as f64 + 1.0);
        let h = if hsig { 1.0 } else { 0.0 };
        let kc = (self.cc * (2.0 - self.cc) * self.mueff).sqrt();
        for i in 0..n {
            self.pc[i] = (1.0 - self.cc) * self.pc[i] + h * kc * ymean[i];
            let mut rank_mu = 0.0;
            for (r, &idx) in order.iter().take(self.mu).enumerate() {
                rank_mu += self.w[r] * ys[idx][i] * ys[idx][i];
            }
            self.c[i] = (1.0 - self.c1 - self.cmu) * self.c[i]
                + self.c1 * (self.pc[i] * self.pc[i] + (1.0 - h) * self.cc * (2.0 - self.cc) * self.c[i])
                + self.cmu * rank_mu;
            let c_max = if self.scale_of(i) < 1.0 { 1.0 } else { 20.0 };
            self.c[i] = self.c[i].clamp(1e-4, c_max);
        }
        self.sigma = (self.sigma * ((self.cs / self.damps) * (psn / self.chi_n - 1.0)).exp()).clamp(1e-3, 0.5);
        self.generation += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn band_db(x: &[f32], lo: f64, hi: f64) -> f64 {
        let n = 8192usize.min(x.len());
        let mid = (0.6 * FS) as usize;
        let seg: Vec<f64> = x[mid..mid + n].iter().map(|&s| s as f64).collect();
        let w = hann(n);
        let mut re = vec![0.0; n];
        for (i, s) in seg.iter().enumerate() {
            re[i] = s * w[i];
        }
        let mut e = 0.0;
        for k in 0..n / 2 {
            let f = k as f64 * FS / n as f64;
            if f >= lo && f < hi {
                let (mut a, mut b) = (0.0, 0.0);
                // direct DFT bin: small band, fine for a probe
                for (i, r) in re.iter().enumerate() {
                    let ph = -2.0 * std::f64::consts::PI * (k * i) as f64 / n as f64;
                    a += r * ph.cos();
                    b += r * ph.sin();
                }
                e += a * a + b * b;
            }
        }
        10.0 * (e + 1e-30).log10()
    }

    /// The render follows a pitch track: a flat 300 Hz track on a note written at 523 Hz.
    #[test]
    fn follows_the_pitch_track() {
        let notes = crate::csd::parse("start,end,midi,syl\n0.0,1.2,72,a\n", "probe").unwrap();
        let base: Vec<f64> = Spec::new(1).genes.iter().map(|g| g.def).collect();
        for (hz, track) in [(300.0, vec![300.0; 150]), (523.25, vec![])] {
            let out = render(&notes, &base, 1.4, &track);
            let x: Vec<f64> = out[(0.5 * FS) as usize..(0.6 * FS) as usize].iter().map(|&s| s as f64).collect();
            let p = crate::analysis::pitch::yin_pitch(&x, FS, crate::analysis::pitch::YinOpts { min_f0: Some(100.0), max_f0: Some(900.0), threshold: Some(0.3) });
            eprintln!("target {hz} Hz -> measured {:.1} Hz", p.f0);
        }
        for (gene, val) in [(G_TENSION, 0.25), (G_TENSION, 0.9), (G_PRESSURE, 5.3), (G_PRESSURE, 16.0), (G_SCALE, 0.8), (G_CHINK, 0.38), (G_SMOOTH, 0.5)] {
            let mut v = base.clone();
            v[gene] = val;
            let out = render(&notes, &v, 1.4, &[300.0; 150]);
            let x: Vec<f64> = out[(0.5 * FS) as usize..(0.6 * FS) as usize].iter().map(|&s| s as f64).collect();
            let p = crate::analysis::pitch::yin_pitch(&x, FS, crate::analysis::pitch::YinOpts { min_f0: Some(100.0), max_f0: Some(900.0), threshold: Some(0.3) });
            eprintln!("gene {gene} = {val}: measured {:.1} Hz for 300", p.f0);
        }
    }

    /// Probe, not a gate: prints band energies for the new tract/noise genes so a change can be seen.
    #[test]
    #[ignore]
    fn probe_epilarynx_and_aspiration() {
        let notes = crate::csd::parse("start,end,midi,syl\n0.0,1.2,72,a\n", "probe").unwrap();
        let spec = Spec::new(1);
        let base: Vec<f64> = spec.genes.iter().map(|g| g.def).collect();
        for (epi, asp) in [(0.0, 3500.0), (0.9, 3500.0), (0.0, 7000.0), (0.9, 7000.0)] {
            let mut v = base.clone();
            v[G_ASPIRATION] = 8.0;
            v[G_EPI] = epi;
            v[G_ASP_HZ] = asp;
            let out = render(&notes, &v, 1.4, &[]);
            eprintln!(
                "epi {epi:.1} asp {asp:5.0}: 0.5-1.5k {:.1}  2-3k {:.1}  3-5k {:.1}  5-8k {:.1} dB",
                band_db(&out, 500.0, 1500.0),
                band_db(&out, 2000.0, 3000.0),
                band_db(&out, 3000.0, 5000.0),
                band_db(&out, 5000.0, 8000.0)
            );
        }
    }
}
