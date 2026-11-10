//! Resonance peaks of the human airway per vowel, with parts of the anatomy switched off one at a
//! time: which part makes which peak. Peaks of |U_lips+nose / U_glottis| on a 5 Hz grid.
//!
//! `cargo run --release -q -p chimera --example tract_probe -- [male|female] [variant]`
//! variants: base, nofossa (piriform fossae closed), epi1 (epilarynx fully narrowed), visc4k
//! (viscous loss taken at 4 kHz, not 700 Hz), ph<x> (pharynx x times as long), sweep (mean F1-F4
//! over the vowels for a grid of pharynx lengths and epilarynx settings), ring (what the UI's
//! Ring setting adds at 2.4-3.6 kHz)
use chimera::airway::frequency::{find_peaks, transfer_function, Peak};
use chimera::anatomy::human::{HumanBody, BODY_FEMALE, BODY_MALE, NEUTRAL};
use chimera::phonetics::planner::vowel_table;
use chimera::voice::human_airway::HumanAirway;

const VOWELS: [&str; 5] = ["ɑ", "e", "i", "o", "u"];

fn peaks(body: HumanBody, body_name: &str, ipa: &str, variant: &str, epi: Option<f64>) -> (Vec<Peak>, HumanAirway) {
    let freqs: Vec<f64> = (0..1580).map(|i| 100.0 + 5.0 * i as f64).collect();
    let mut air = HumanAirway::new(96000.0, body);
    let mut a = vowel_table()[body_name][ipa].artic.apply_to(&NEUTRAL);
    if variant == "epi1" {
        a.epilarynx = 1.0;
    }
    if let Some(e) = epi {
        a.epilarynx = e;
    }
    air.apply(&a, 0.0);
    if variant == "nofossa" {
        let z = vec![0.0; air.fossa.n];
        air.net.set_tube_targets(air.fossa, &z, None, None);
    }
    if variant == "visc4k" {
        air.net.viscous_omega = 2.0 * std::f64::consts::PI * 4000.0;
    }
    let el = air.net.linear_elements();
    let h = transfer_function(&el, air.pharynx.first_node(), &freqs, &[air.glottis_port]);
    (find_peaks(&freqs, &h.mag, 150.0), air)
}

/// Mean level (dB) of |U_radiated / U_glottis| between lo and hi Hz, for one epilarynx setting.
fn band_db(body: HumanBody, body_name: &str, ipa: &str, epi: f64, lo: f64, hi: f64) -> f64 {
    let freqs: Vec<f64> = (0..240).map(|i| lo + (hi - lo) * i as f64 / 239.0).collect();
    let mut air = HumanAirway::new(96000.0, body);
    let mut a = vowel_table()[body_name][ipa].artic.apply_to(&NEUTRAL);
    a.epilarynx = epi;
    air.apply(&a, 0.0);
    let el = air.net.linear_elements();
    let h = transfer_function(&el, air.pharynx.first_node(), &freqs, &[air.glottis_port]);
    let p: f64 = h.mag.iter().map(|m| m * m).sum::<f64>() / freqs.len() as f64;
    10.0 * p.log10()
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let body_name = args.first().map(String::as_str).unwrap_or("male");
    let variant = args.get(1).map(String::as_str).unwrap_or("base");
    let mut body = if body_name == "female" { BODY_FEMALE } else { BODY_MALE };
    if variant == "ring" {
        // the UI's Ring button (epilarynx 0.85) against rest, energy in 2.4-3.6 kHz
        let s: Vec<String> = VOWELS.iter().map(|v| format!("{v} {:+.1}", band_db(body, body_name, v, 0.85, 2400.0, 3600.0) - band_db(body, body_name, v, 0.0, 2400.0, 3600.0))).collect();
        println!("ring 0.85 vs rest, 2.4-3.6 kHz (dB): {}", s.join("  "));
        return;
    }
    if variant == "sweep" {
        // F4 is the 4th peak; "top" is the strongest peak between 2.5 and 5.5 kHz
        println!("pharynx  epi    F1    F2    F3    F4   top(2.5-5.5k)");
        for p in [1.0, 1.05, 1.1, 1.15] {
            for e in [0.0, 0.3, 0.5, 0.7, 1.0] {
                let mut b = body;
                b.pharynx *= p;
                let mut f = [0.0; 5];
                for ipa in VOWELS {
                    let (pk, _) = peaks(b, body_name, ipa, "base", Some(e));
                    for i in 0..4 {
                        f[i] += pk[i].freq / 5.0;
                    }
                    let top = pk.iter().filter(|q| q.freq > 2500.0 && q.freq < 5500.0).max_by(|x, y| x.db.total_cmp(&y.db)).unwrap();
                    f[4] += top.freq / 5.0;
                }
                println!("{p:6.2} {e:5.1} {:5.0} {:5.0} {:5.0} {:5.0} {:6.0}", f[0], f[1], f[2], f[3], f[4]);
            }
        }
        return;
    }
    // "ph1.15": pharynx 15% longer
    if let Some(x) = variant.strip_prefix("ph") {
        body.pharynx *= x.parse::<f64>().unwrap();
    }
    for ipa in VOWELS {
        let (pk, air) = peaks(body, body_name, ipa, variant, None);
        let top = pk.iter().map(|p| p.db).fold(f64::MIN, f64::max);
        let s: Vec<String> = pk.iter().filter(|p| p.db > top - 30.0).map(|p| format!("{:.0}({:+.0} dB, bw {:.0})", p.freq, p.db - top, p.bw)).collect();
        println!("{ipa}: {}", s.join("  "));
        if ipa == "ɑ" {
            let ph: Vec<String> = air.ph_areas.iter().take(8).map(|x| format!("{x:.2}")).collect();
            println!("   pharynx {:.1} cm in {} sections, oral {:.1} cm, first areas {}", air.ph_len, air.n_ph, air.or_len, ph.join(" "));
        }
    }
}
