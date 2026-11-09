//! `chimera quality`: voice-quality measurements of WAV files, or of every ref/best pair an evolve run
//! has saved. Prints one row per file so a render can be read against its recording.

use crate::compare::read_wav;
use chimera::analysis::quality::{Quality, measure};

const HEADER: &str = "file                                      voiced   f0  jitter% shimmer%  hnr  cpp  h1-h2  tilt  fm_c  fm_Hz  am_dB";

fn row(name: &str, q: &Quality) -> String {
    format!(
        "{name:<40} {:6.0}% {:5.0} {:7.2} {:8.2} {:5.1} {:4.1} {:6.1} {:5.1} {:5.1} {:6.1} {:6.2}",
        100.0 * q.voiced,
        q.f0_mean,
        100.0 * q.jitter_rap,
        100.0 * q.shimmer_apq3,
        q.hnr_db,
        q.cpp_db,
        q.h1h2_db,
        q.tilt_db_oct,
        q.fm_cents,
        q.fm_rate_hz,
        q.am_db,
    )
}

/// Band edges (Hz) of the long-term spectrum table.
const BAND_EDGES: [f64; 11] = [100.0, 250.0, 500.0, 1000.0, 2000.0, 3000.0, 4000.0, 6000.0, 8000.0, 12000.0, 20000.0];

/// Long-term average spectrum of a clip in dB per Hz, one value per band (loud frames only, so
/// silence between notes does not pull the mean down).
fn band_levels(x: &[f64], rate: f64) -> Vec<f64> {
    use chimera::analysis::fft::{Fft, hann};
    let size = 2048;
    let fft = Fft::new(size);
    let win = hann(size);
    let mut frames: Vec<(f64, Vec<f64>)> = Vec::new();
    let mut t = 0;
    while t + size <= x.len() {
        let mut re: Vec<f64> = (0..size).map(|i| x[t + i] * win[i]).collect();
        let mut im = vec![0.0; size];
        fft.transform(&mut re, &mut im);
        let p: Vec<f64> = (0..=size / 2).map(|k| re[k] * re[k] + im[k] * im[k]).collect();
        frames.push((p.iter().sum(), p));
        t += size / 2;
    }
    let loudest = frames.iter().map(|f| f.0).fold(0.0, f64::max);
    let mut mean = vec![0.0; size / 2 + 1];
    let mut k = 0.0f64;
    for (e, p) in &frames {
        if *e > loudest * 1e-3 {
            for (m, v) in mean.iter_mut().zip(p) {
                *m += v;
            }
            k += 1.0;
        }
    }
    let bin_hz = rate / size as f64;
    BAND_EDGES
        .windows(2)
        .map(|w| {
            let (lo, hi) = ((w[0] / bin_hz) as usize, ((w[1] / bin_hz) as usize).min(size / 2));
            let sum: f64 = mean[lo..hi].iter().sum::<f64>() / k.max(1.0);
            10.0 * (sum / (hi - lo).max(1) as f64 + 1e-30).log10()
        })
        .collect()
}

/// Mean band levels of the recordings and the renders, and the gap between them.
fn print_bands(dir: &str, refs: &[String]) -> Result<(), String> {
    let nb = BAND_EDGES.len() - 1;
    let (mut sr, mut sb) = (vec![0.0; nb], vec![0.0; nb]);
    for r in refs {
        let b = r.replace("_ref.wav", "_best.wav");
        let (xr, rr) = read_wav(&format!("{dir}/{r}"))?;
        let (xb, rb) = read_wav(&format!("{dir}/{b}"))?;
        for (s, v) in sr.iter_mut().zip(band_levels(&xr, rr)) {
            *s += v;
        }
        for (s, v) in sb.iter_mut().zip(band_levels(&xb, rb)) {
            *s += v;
        }
    }
    let n = refs.len() as f64;
    println!("\nlong-term spectrum, dB per Hz (render minus recording; negative = render too quiet)");
    println!("band Hz        recording    render      gap");
    for i in 0..nb {
        println!(
            "{:6.0}-{:<6.0} {:10.1} {:9.1} {:9.1}",
            BAND_EDGES[i],
            BAND_EDGES[i + 1],
            sr[i] / n,
            sb[i] / n,
            (sb[i] - sr[i]) / n
        );
    }
    println!();
    Ok(())
}

fn measure_file(path: &str) -> Result<Quality, String> {
    let (x, rate) = read_wav(path)?;
    Ok(measure(&x, rate))
}

pub fn run(a: &[String]) -> Result<(), String> {
    if a.is_empty() {
        return Err("usage: chimera quality <a.wav> [b.wav ...] | --pairs <evolve run dir>".into());
    }
    println!("{HEADER}");
    if a[0] == "--pairs" {
        let dir = format!("{}/pairs", a.get(1).ok_or("--pairs needs a run directory")?);
        let mut refs: Vec<String> = std::fs::read_dir(&dir)
            .map_err(|e| format!("{dir}: {e}"))?
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with("_ref.wav"))
            .collect();
        refs.sort();
        let (mut sum_r, mut sum_b, mut n) = (Quality::default(), Quality::default(), 0.0);
        for r in &refs {
            let b = r.replace("_ref.wav", "_best.wav");
            let (qr, qb) = (measure_file(&format!("{dir}/{r}"))?, measure_file(&format!("{dir}/{b}"))?);
            println!("{}", row(&r.replace(".wav", ""), &qr));
            println!("{}", row(&b.replace(".wav", ""), &qb));
            for (s, q) in [(&mut sum_r, &qr), (&mut sum_b, &qb)] {
                s.voiced += q.voiced;
                s.f0_mean += q.f0_mean;
                s.jitter_rap += q.jitter_rap;
                s.shimmer_apq3 += q.shimmer_apq3;
                s.hnr_db += q.hnr_db;
                s.cpp_db += q.cpp_db;
                s.h1h2_db += q.h1h2_db;
                s.tilt_db_oct += q.tilt_db_oct;
                s.fm_cents += q.fm_cents;
                s.fm_rate_hz += q.fm_rate_hz;
                s.am_db += q.am_db;
            }
            n += 1.0;
        }
        if n > 0.0 {
            print_bands(&dir, &refs)?;
            let mean =|s: Quality| Quality {
                voiced: s.voiced / n,
                f0_mean: s.f0_mean / n,
                jitter_rap: s.jitter_rap / n,
                shimmer_apq3: s.shimmer_apq3 / n,
                hnr_db: s.hnr_db / n,
                cpp_db: s.cpp_db / n,
                h1h2_db: s.h1h2_db / n,
                tilt_db_oct: s.tilt_db_oct / n,
                fm_cents: s.fm_cents / n,
                fm_rate_hz: s.fm_rate_hz / n,
                am_db: s.am_db / n,
                cycles: 0,
            };
            println!("{}", row("MEAN recordings", &mean(sum_r)));
            println!("{}", row("MEAN renders", &mean(sum_b)));
        }
        return Ok(());
    }
    for f in a {
        let name = f.rsplit(['/', '\\']).next().unwrap_or(f);
        println!("{}", row(name, &measure_file(f)?));
    }
    Ok(())
}
