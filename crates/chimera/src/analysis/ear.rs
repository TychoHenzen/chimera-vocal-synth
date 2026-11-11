//! What a listener's preferences are learned from: Evolve's "learn from my ear" mode fits a
//! preference model to the listener's A/B answers over these numbers, so every render must reduce
//! to the same short list. None of them depends on the render's loudness (the page plays every
//! candidate at one loudness, so the listener cannot hear it either), and none of them is the
//! pitch or loudness contour, which follows the recording in every render.
//!
//! - `band ...`: the long-term spectrum's level in each band, relative to the whole 100 Hz - 12 kHz
//!   (dB), over the frames within `SOUNDING_DB` of the loudest.
//! - `jitter`, `shimmer`, `HNR`, `CPP`, `H1-H2`, `tilt`: `quality::measure` (jitter and shimmer as
//!   natural logs, since they span decades).
//! - `ring ...`: how far the spectral envelope (cepstrally smoothed, so the harmonics are gone)
//!   rises above its own valleys in each band, dB: sharp formants ring, damped ones are flat.
//! - `noise 4-10 kHz`: spectral flatness there, dB (0 = white noise, very negative = harmonic).

use super::fft::{Fft, hann};
use super::quality;
use crate::math::{exp, ln, log10};

/// Edges of the `band` features (Hz).
pub const BAND_EDGES: [f64; 10] = [
    100.0, 250.0, 500.0, 1000.0, 2000.0, 3000.0, 4000.0, 6000.0, 8000.0, 12000.0,
];
/// Bands of the `ring` features (Hz).
const RING_BANDS: [(f64, f64); 3] = [(200.0, 1200.0), (1200.0, 2500.0), (2500.0, 4500.0)];
const NOISE_BAND: (f64, f64) = (4000.0, 10000.0);
/// A frame counts when it is within this many dB of the loudest frame.
const SOUNDING_DB: f64 = 30.0;
const FRAME: usize = 2048;
const HOP: usize = 512;
/// Quefrency (s) above which the cepstrum is cut to leave the spectral envelope. ASSUMPTION: 1.2 ms
/// removes the harmonics of any pitch below about 800 Hz and keeps formants about 800 Hz apart.
const LIFTER_S: f64 = 0.0012;

pub const N_FEATURES: usize = 19;
pub const FEATURE_NAMES: [&str; N_FEATURES] = [
    "band 100-250 Hz",
    "band 250-500 Hz",
    "band 0.5-1 kHz",
    "band 1-2 kHz",
    "band 2-3 kHz",
    "band 3-4 kHz",
    "band 4-6 kHz",
    "band 6-8 kHz",
    "band 8-12 kHz",
    "jitter",
    "shimmer",
    "HNR",
    "CPP",
    "H1-H2",
    "tilt",
    "ring 0.2-1.2 kHz",
    "ring 1.2-2.5 kHz",
    "ring 2.5-4.5 kHz",
    "noise 4-10 kHz",
];

/// The features of a mono recording or render at `rate` Hz; all zeros when it is silent or
/// shorter than one frame.
pub fn features(x: &[f64], rate: f64) -> [f64; N_FEATURES] {
    let mut out = [0.0; N_FEATURES];
    if x.len() < FRAME {
        return out;
    }
    let starts: Vec<usize> = (0..=(x.len() - FRAME) / HOP).map(|f| f * HOP).collect();
    let level: Vec<f64> = starts
        .iter()
        .map(|&s| {
            10.0 * log10(x[s..s + FRAME].iter().map(|v| v * v).sum::<f64>() / FRAME as f64 + 1e-30)
        })
        .collect();
    let loudest = level.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    if loudest < -100.0 {
        return out;
    }
    let fft = Fft::new(FRAME);
    let win = hann(FRAME);
    let half = FRAME / 2;
    let bin_hz = rate / FRAME as f64;
    let bin = |hz: f64| ((hz / bin_hz).round() as usize).min(half);
    let lifter = ((LIFTER_S * rate) as usize).max(1);

    let nb = BAND_EDGES.len() - 1;
    let mut band_power = vec![0.0; nb];
    let mut ring = [0.0; RING_BANDS.len()];
    let mut noise = 0.0;
    let mut frames = 0usize;
    let mut re = vec![0.0; FRAME];
    let mut im = vec![0.0; FRAME];
    for (&s, &l) in starts.iter().zip(&level) {
        if l < loudest - SOUNDING_DB {
            continue;
        }
        frames += 1;
        for i in 0..FRAME {
            re[i] = x[s + i] * win[i];
            im[i] = 0.0;
        }
        fft.transform(&mut re, &mut im);
        let power: Vec<f64> = (0..=half)
            .map(|b| re[b] * re[b] + im[b] * im[b] + 1e-30)
            .collect();
        for k in 0..nb {
            band_power[k] += power[bin(BAND_EDGES[k])..bin(BAND_EDGES[k + 1])]
                .iter()
                .sum::<f64>();
        }

        // the envelope: the dB spectrum's cepstrum, cut above the lifter, transformed back
        for b in 0..=half {
            re[b] = 10.0 * log10(power[b]);
            im[b] = 0.0;
        }
        for b in 1..half {
            re[FRAME - b] = re[b];
            im[FRAME - b] = 0.0;
        }
        fft.transform(&mut re, &mut im);
        for q in lifter + 1..FRAME - lifter {
            re[q] = 0.0;
            im[q] = 0.0;
        }
        // a forward transform of a real, even sequence is its inverse times FRAME
        fft.transform(&mut re, &mut im);
        for (k, &(lo, hi)) in RING_BANDS.iter().enumerate() {
            let env = &re[bin(lo)..=bin(hi)];
            let top = env.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
            let bottom = env.iter().cloned().fold(f64::INFINITY, f64::min);
            ring[k] += (top - bottom) / FRAME as f64;
        }

        let p = &power[bin(NOISE_BAND.0)..=bin(NOISE_BAND.1)];
        let geo = p.iter().map(|&v| ln(v)).sum::<f64>() / p.len() as f64;
        let arith = p.iter().sum::<f64>() / p.len() as f64;
        noise += 10.0 * log10(exp(geo) / arith);
    }
    let n = frames as f64;
    let total: f64 = band_power.iter().sum();
    for k in 0..nb {
        out[k] = 10.0 * log10(band_power[k] / total + 1e-30);
    }

    let q = quality::measure(x, rate);
    out[nb] = ln(q.jitter_rap.max(1e-5));
    out[nb + 1] = ln(q.shimmer_apq3.max(1e-5));
    out[nb + 2] = q.hnr_db;
    out[nb + 3] = q.cpp_db;
    out[nb + 4] = q.h1h2_db;
    out[nb + 5] = q.tilt_db_oct;
    for k in 0..RING_BANDS.len() {
        out[nb + 6 + k] = ring[k] / n;
    }
    out[N_FEATURES - 1] = noise / n;
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f64 = 48000.0;

    /// A 150 Hz tone with a falling spectrum, two seconds long.
    fn buzz(gain: f64) -> Vec<f64> {
        (0..(2.0 * RATE) as usize)
            .map(|i| {
                let t = i as f64 / RATE;
                gain * (1..60)
                    .map(|k| (std::f64::consts::TAU * 150.0 * k as f64 * t).sin() / k as f64)
                    .sum::<f64>()
            })
            .collect()
    }

    fn noise(gain: f64) -> Vec<f64> {
        let mut s = 0x9e3779b97f4a7c15u64;
        (0..(2.0 * RATE) as usize)
            .map(|_| {
                s ^= s << 13;
                s ^= s >> 7;
                s ^= s << 17;
                gain * ((s >> 11) as f64 / (1u64 << 53) as f64 - 0.5)
            })
            .collect()
    }

    #[test]
    fn loudness_does_not_change_the_features() {
        let (a, b) = (features(&buzz(0.3), RATE), features(&buzz(0.003), RATE));
        for k in 0..N_FEATURES {
            assert!(
                (a[k] - b[k]).abs() < 0.05,
                "{} moved from {} to {}",
                FEATURE_NAMES[k],
                a[k],
                b[k]
            );
        }
    }

    #[test]
    fn noise_is_flatter_above_4_khz_than_a_harmonic_tone() {
        let (tone, hiss) = (features(&buzz(0.3), RATE), features(&noise(0.3), RATE));
        let k = N_FEATURES - 1;
        assert!(
            hiss[k] > tone[k] + 3.0,
            "noise {} vs tone {}",
            hiss[k],
            tone[k]
        );
        assert!(
            hiss[k] > -3.0,
            "white noise should be nearly flat: {}",
            hiss[k]
        );
    }

    #[test]
    fn silence_and_short_input_give_zeros() {
        assert_eq!(features(&vec![0.0; 48000], RATE), [0.0; N_FEATURES]);
        assert_eq!(features(&[0.1; 100], RATE), [0.0; N_FEATURES]);
    }

    #[test]
    fn every_feature_is_finite_and_named() {
        let f = features(&buzz(0.3), RATE);
        assert!(f.iter().all(|v| v.is_finite()), "{f:?}");
        assert_eq!(FEATURE_NAMES.len(), N_FEATURES);
    }
}
