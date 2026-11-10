//! Voice-quality measurements of a recording or a render: the cycle-level texture a spectrogram
//! loss cannot see (jitter, shimmer, harmonics-to-noise, cepstral peak, breathiness) and the slow
//! modulation a real voice carries (vibrato and loudness variation).
//!
//! These are diagnostics and range targets, not numbers to push up: compare a render with a
//! recording measured by the same code. Every figure is computed on voiced frames only.
//!
//! - `jitter_rap` / `shimmer_apq3`: three-cycle perturbation measures, so a steady vibrato does not
//!   count as jitter (Praat's definitions).
//! - `cpp_db`: cepstral peak prominence, the height of the pitch peak in the cepstrum above a
//!   regression line (Hillenbrand and Houde 1996).
//! - `h1h2_db`: level of the first harmonic minus the second, uncorrected; higher = breathier.
//! - `fm_cents`, `fm_rate_hz`, `am_db`: spread of the pitch and loudness once the slow trend (phrase
//!   contour, note envelope) is removed, and the dominant pitch-modulation rate.

use super::fft::{Fft, hann};
use super::pitch::{YinOpts, yin_pitch};
use serde::Serialize;

const FRAME_S: f64 = 0.05;
const HOP_S: f64 = 0.01;
const MIN_F0: f64 = 80.0;
const MAX_F0: f64 = 900.0;
/// A frame counts as voiced when YIN's aperiodicity is below this ...
const VOICED_APERIODICITY: f64 = 0.25;
/// ... and it is no more than this far below the loudest frame.
const FLOOR_DB: f64 = 40.0;
/// Trend removed before measuring vibrato and tremolo (frames at 100 Hz): a 0.3 s moving average.
const TREND_FRAMES: usize = 30;
/// A cycle length further than this ratio from the local period is not a cycle (Praat uses 1.3).
const MAX_PERIOD_RATIO: f64 = 1.3;

#[derive(Clone, Copy, Debug, Default, Serialize)]
pub struct Quality {
    /// share of frames that are voiced
    pub voiced: f64,
    pub f0_mean: f64,
    /// relative average perturbation of the cycle length, ratio (0.002 = 0.2 %)
    pub jitter_rap: f64,
    /// three-point amplitude perturbation quotient of the cycle peaks, ratio
    pub shimmer_apq3: f64,
    /// harmonics-to-noise ratio from the autocorrelation peak, dB
    pub hnr_db: f64,
    pub cpp_db: f64,
    pub h1h2_db: f64,
    /// slope of the 300 Hz - 4 kHz spectrum, dB per octave
    pub tilt_db_oct: f64,
    /// standard deviation of the pitch around its 0.3 s trend, cents
    pub fm_cents: f64,
    /// strongest pitch-modulation rate between 3 and 9 Hz, Hz (0 if none)
    pub fm_rate_hz: f64,
    /// standard deviation of the loudness around its 0.3 s trend, dB
    pub am_db: f64,
    /// number of cycles the perturbation measures used
    pub cycles: usize,
}

struct Frame {
    t: usize,
    f0: f64,
    voiced: bool,
    rms_db: f64,
}

pub fn measure(x: &[f64], rate: f64) -> Quality {
    let n = (FRAME_S * rate) as usize;
    let hop = (HOP_S * rate) as usize;
    if x.len() < 2 * n || hop == 0 {
        return Quality::default();
    }
    let opts = YinOpts { min_f0: Some(MIN_F0), max_f0: Some(MAX_F0), threshold: Some(VOICED_APERIODICITY) };
    let mut frames: Vec<Frame> = Vec::new();
    let mut t = 0;
    while t + n <= x.len() {
        let f = &x[t..t + n];
        let rms = (f.iter().map(|v| v * v).sum::<f64>() / n as f64).sqrt();
        let p = yin_pitch(f, rate, opts);
        frames.push(Frame { t, f0: p.f0, voiced: p.f0 > 0.0, rms_db: 20.0 * (rms + 1e-12).log10() });
        t += hop;
    }
    let loudest = frames.iter().map(|f| f.rms_db).fold(f64::NEG_INFINITY, f64::max);
    for f in frames.iter_mut() {
        f.voiced = f.voiced && f.rms_db > loudest - FLOOR_DB;
    }
    let voiced_n = frames.iter().filter(|f| f.voiced).count();
    let mut q = Quality { voiced: voiced_n as f64 / frames.len() as f64, ..Default::default() };
    if voiced_n < 5 {
        return q;
    }
    q.f0_mean = frames.iter().filter(|f| f.voiced).map(|f| f.f0).sum::<f64>() / voiced_n as f64;

    let (hnr, cpp, h1h2, tilt) = spectral_measures(x, rate, &frames, n);
    q.hnr_db = hnr;
    q.cpp_db = cpp;
    q.h1h2_db = h1h2;
    q.tilt_db_oct = tilt;

    let (jit, shim, cycles) = perturbation(x, rate, &frames, hop);
    q.jitter_rap = jit;
    q.shimmer_apq3 = shim;
    q.cycles = cycles;

    let (fm, rate_hz, am) = modulation(&frames);
    q.fm_cents = fm;
    q.fm_rate_hz = rate_hz;
    q.am_db = am;
    q
}

/// HNR, CPP, H1-H2 and spectral tilt, each averaged over the voiced frames.
fn spectral_measures(x: &[f64], rate: f64, frames: &[Frame], n: usize) -> (f64, f64, f64, f64) {
    let size = super::fft::next_pow2(n as f64 * 2.0);
    let fft = Fft::new(size);
    let win = hann(n);
    let (mut hnr, mut cpp, mut h12, mut tilt, mut k) = (0.0, 0.0, 0.0, 0.0, 0usize);
    for f in frames.iter().filter(|f| f.voiced) {
        let frame = &x[f.t..f.t + n];
        // HNR: normalised autocorrelation at the pitch lag
        let lag = (rate / f.f0).round() as usize;
        if lag == 0 || lag >= n / 2 {
            continue;
        }
        let (mut r0, mut r1, mut rl) = (0.0, 0.0, 0.0);
        for i in 0..n - lag {
            r0 += frame[i] * frame[i];
            r1 += frame[i + lag] * frame[i + lag];
            rl += frame[i] * frame[i + lag];
        }
        let r = (rl / (r0 * r1).sqrt().max(1e-30)).clamp(1e-4, 0.9999);
        let h = 10.0 * (r / (1.0 - r)).log10();

        let mut re = vec![0.0; size];
        let mut im = vec![0.0; size];
        for i in 0..n {
            re[i] = frame[i] * win[i];
        }
        fft.transform(&mut re, &mut im);
        let half = size / 2;
        let db: Vec<f64> = (0..=half).map(|b| 10.0 * (re[b] * re[b] + im[b] * im[b] + 1e-30).log10()).collect();
        let bin_hz = rate / size as f64;

        // H1 - H2: strongest bins within 10 % of f0 and 2 f0
        let peak = |centre: f64| -> f64 {
            let lo = ((centre * 0.9) / bin_hz).floor() as usize;
            let hi = (((centre * 1.1) / bin_hz).ceil() as usize).min(half);
            db[lo.min(half)..=hi].iter().cloned().fold(f64::NEG_INFINITY, f64::max)
        };
        let h1h2 = peak(f.f0) - peak(2.0 * f.f0);

        // tilt: least-squares line of dB over log2(frequency), 300 Hz - 4 kHz
        let (b0, b1) = ((300.0 / bin_hz) as usize, ((4000.0 / bin_hz) as usize).min(half));
        let lo = b0.max(1);
        let (slope, _) = line_fit(db[lo..=b1].iter().enumerate().map(|(i, &y)| (((lo + i) as f64 * bin_hz).log2(), y)));

        // CPP: cepstrum of the dB spectrum, peak in the pitch range minus a regression line
        let mut cre: Vec<f64> = db.iter().copied().chain(db[1..half].iter().rev().copied()).collect();
        cre.resize(size, 0.0);
        let mut cim = vec![0.0; size];
        fft.transform(&mut cre, &mut cim);
        let ceps: Vec<f64> = (0..half).map(|q| (cre[q] * cre[q] + cim[q] * cim[q]).sqrt() / size as f64).collect();
        let q_lo = (rate / MAX_F0).ceil() as usize;
        let q_hi = ((rate / MIN_F0).floor() as usize).min(half - 1);
        if q_lo + 2 >= q_hi {
            continue;
        }
        let mut qp = q_lo;
        for q in q_lo..=q_hi {
            if ceps[q] > ceps[qp] {
                qp = q;
            }
        }
        let cdb: Vec<f64> = ceps.iter().map(|c| 20.0 * (c + 1e-12).log10()).collect();
        let (a, b) = line_fit(cdb[q_lo..=q_hi].iter().enumerate().map(|(i, &y)| ((q_lo + i) as f64, y)));

        hnr += h;
        cpp += cdb[qp] - (a * qp as f64 + b);
        h12 += h1h2;
        tilt += slope;
        k += 1;
    }
    if k == 0 {
        return (0.0, 0.0, 0.0, 0.0);
    }
    let k = k as f64;
    (hnr / k, cpp / k, h12 / k, tilt / k)
}

/// Least-squares line through (x, y) points: (slope, intercept).
fn line_fit(points: impl Iterator<Item = (f64, f64)>) -> (f64, f64) {
    let (mut sx, mut sy, mut sxx, mut sxy, mut m) = (0.0, 0.0, 0.0, 0.0, 0.0);
    for (x, y) in points {
        sx += x;
        sy += y;
        sxx += x * x;
        sxy += x * y;
        m += 1.0;
    }
    let slope = (m * sxy - sx * sy) / (m * sxx - sx * sx).max(1e-12);
    (slope, (sy - slope * sx) / m)
}

/// Mean RAP and APQ3 over runs of cycles found by following the waveform peaks.
fn perturbation(x: &[f64], rate: f64, frames: &[Frame], hop: usize) -> (f64, f64, usize) {
    // smooth away the harmonics above the first formants so the peak is the glottal cycle's
    let w = ((rate / 3000.0).round() as usize).max(1);
    let mut s = x.to_vec();
    for _ in 0..3 {
        let mut acc = 0.0;
        let mut out = vec![0.0; s.len()];
        for i in 0..s.len() {
            acc += s[i];
            if i >= w {
                acc -= s[i - w];
            }
            out[i] = acc / w as f64;
        }
        s = out;
    }
    let f0_at = |i: usize| -> Option<f64> {
        let idx = (i / hop).min(frames.len() - 1);
        // the frame starting at idx*hop covers [idx*hop, idx*hop + FRAME_S]; use its centre
        let centre = ((i as f64 - 0.5 * FRAME_S * rate) / hop as f64).round().max(0.0) as usize;
        let f = &frames[centre.min(frames.len() - 1)];
        let _ = idx;
        f.voiced.then_some(f.f0)
    };
    let (mut rap_sum, mut apq_sum, mut triples) = (0.0, 0.0, 0usize);
    let mut cycles = 0usize;
    let mut i = 0usize;
    while i + 2 < s.len() {
        let Some(f0) = f0_at(i) else {
            i += hop;
            continue;
        };
        // first peak of a run
        let t0 = rate / f0;
        let end = (i as f64 + 1.2 * t0) as usize;
        let Some(first) = argmax(&s, i, end.min(s.len() - 2)) else { break };
        let mut peaks: Vec<(f64, f64)> = vec![refine(&s, first)];
        loop {
            let last = peaks.last().unwrap().0;
            let Some(f0) = f0_at(last as usize) else { break };
            let t = rate / f0;
            let lo = (last + 0.75 * t) as usize;
            let hi = (last + 1.25 * t) as usize;
            if hi + 1 >= s.len() {
                break;
            }
            let Some(p) = argmax(&s, lo, hi) else { break };
            let (pos, amp) = refine(&s, p);
            let period = pos - last;
            if period < t / MAX_PERIOD_RATIO || period > t * MAX_PERIOD_RATIO {
                break;
            }
            peaks.push((pos, amp));
        }
        cycles += peaks.len().saturating_sub(1);
        for k in 1..peaks.len().saturating_sub(2) {
            let t = |j: usize| peaks[j + 1].0 - peaks[j].0;
            let (a, b, c) = (t(k - 1), t(k), t(k + 1));
            let mean = (a + b + c) / 3.0;
            rap_sum += (b - mean).abs() / mean;
            let (pa, pb, pc) = (peaks[k - 1].1, peaks[k].1, peaks[k + 1].1);
            let am = (pa + pb + pc) / 3.0;
            if am > 0.0 {
                apq_sum += (pb - am).abs() / am;
            }
            triples += 1;
        }
        i = (peaks.last().unwrap().0 as usize + 1).max(i + 1);
    }
    if triples == 0 {
        return (0.0, 0.0, cycles);
    }
    (rap_sum / triples as f64, apq_sum / triples as f64, cycles)
}

fn argmax(s: &[f64], lo: usize, hi: usize) -> Option<usize> {
    if lo >= hi || hi >= s.len() {
        return None;
    }
    (lo..=hi).max_by(|&a, &b| s[a].partial_cmp(&s[b]).unwrap_or(std::cmp::Ordering::Equal))
}

/// Parabolic peak position and height around sample `p`.
fn refine(s: &[f64], p: usize) -> (f64, f64) {
    if p == 0 || p + 1 >= s.len() {
        return (p as f64, s[p]);
    }
    let (a, b, c) = (s[p - 1], s[p], s[p + 1]);
    let den = a - 2.0 * b + c;
    if den.abs() < 1e-18 {
        return (p as f64, b);
    }
    let d = 0.5 * (a - c) / den;
    (p as f64 + d, b - 0.25 * (a - c) * d)
}

/// Pitch and loudness modulation around their slow trends, over voiced frames.
fn modulation(frames: &[Frame]) -> (f64, f64, f64) {
    let cents: Vec<Option<f64>> = frames.iter().map(|f| f.voiced.then(|| 1200.0 * f.f0.log2())).collect();
    let loud: Vec<Option<f64>> = frames.iter().map(|f| f.voiced.then_some(f.rms_db)).collect();
    let detrend = |v: &[Option<f64>]| -> Vec<Option<f64>> {
        (0..v.len())
            .map(|i| {
                let x = v[i]?;
                let lo = i.saturating_sub(TREND_FRAMES / 2);
                let hi = (i + TREND_FRAMES / 2 + 1).min(v.len());
                let w: Vec<f64> = v[lo..hi].iter().flatten().copied().collect();
                Some(x - w.iter().sum::<f64>() / w.len() as f64)
            })
            .collect()
    };
    let sd = |v: &[Option<f64>]| -> f64 {
        let w: Vec<f64> = v.iter().flatten().copied().collect();
        if w.len() < 2 {
            return 0.0;
        }
        let m = w.iter().sum::<f64>() / w.len() as f64;
        (w.iter().map(|x| (x - m) * (x - m)).sum::<f64>() / w.len() as f64).sqrt()
    };
    let dc = detrend(&cents);
    let da = detrend(&loud);

    // dominant rate of the detrended pitch: DFT at 3 .. 9 Hz in 0.25 Hz steps (frames are 100 Hz)
    let mut best = (0.0, 0.0);
    let mut hz = 3.0;
    while hz <= 9.0 {
        let (mut re, mut im) = (0.0, 0.0);
        for (i, v) in dc.iter().enumerate() {
            if let Some(v) = v {
                let ph = std::f64::consts::TAU * hz * i as f64 * HOP_S;
                re += v * ph.cos();
                im += v * ph.sin();
            }
        }
        let mag = re * re + im * im;
        if mag > best.1 {
            best = (hz, mag);
        }
        hz += 0.25;
    }
    let fm = sd(&dc);
    // a rate means something only if the modulation is more than analysis noise
    let rate_hz = if fm > 5.0 { best.0 } else { 0.0 };
    (fm, rate_hz, sd(&da))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::TAU;

    /// A harmonic tone with optional vibrato (cents peak, Hz) and noise.
    fn tone(rate: f64, secs: f64, f0: f64, vib: (f64, f64), noise: f64) -> Vec<f64> {
        let mut seed = 12345u64;
        let mut rnd = move || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((seed >> 33) as f64 / (1u64 << 31) as f64) - 0.5
        };
        let mut ph = 0.0;
        (0..(rate * secs) as usize)
            .map(|i| {
                let t = i as f64 / rate;
                let f = f0 * 2f64.powf(vib.0 / 1200.0 * (TAU * vib.1 * t).sin());
                ph += TAU * f / rate;
                (1..=10).map(|h| (h as f64 * ph).sin() / h as f64).sum::<f64>() + noise * rnd()
            })
            .collect()
    }

    #[test]
    fn a_clean_steady_tone_is_periodic_and_unmodulated() {
        let q = measure(&tone(44100.0, 1.0, 200.0, (0.0, 0.0), 0.0), 44100.0);
        assert!(q.voiced > 0.9, "{q:?}");
        assert!((q.f0_mean - 200.0).abs() < 2.0, "{q:?}");
        assert!(q.jitter_rap < 0.002 && q.shimmer_apq3 < 0.02, "{q:?}");
        assert!(q.hnr_db > 25.0, "{q:?}");
        assert!(q.fm_cents < 3.0 && q.fm_rate_hz == 0.0, "{q:?}");
    }

    #[test]
    fn noise_lowers_hnr_and_cpp() {
        let clean = measure(&tone(44100.0, 1.0, 200.0, (0.0, 0.0), 0.0), 44100.0);
        let noisy = measure(&tone(44100.0, 1.0, 200.0, (0.0, 0.0), 1.5), 44100.0);
        assert!(noisy.hnr_db < clean.hnr_db - 8.0, "{clean:?} {noisy:?}");
        assert!(noisy.cpp_db < clean.cpp_db, "{clean:?} {noisy:?}");
    }

    #[test]
    fn vibrato_is_pitch_modulation_not_jitter() {
        let q = measure(&tone(44100.0, 2.0, 200.0, (60.0, 5.5), 0.0), 44100.0);
        assert!((q.fm_rate_hz - 5.5).abs() < 0.6, "{q:?}");
        assert!(q.fm_cents > 25.0 && q.fm_cents < 60.0, "{q:?}");
        assert!(q.jitter_rap < 0.004, "RAP must ignore a steady vibrato: {q:?}");
    }
}
