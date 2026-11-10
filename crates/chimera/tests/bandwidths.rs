//! The tract's high resonances lose energy to the walls as the boundary layer says they should.
//!
//! Viscous loss used to be one resistance taken at 700 Hz, and heat conduction was missing. So the
//! rounded vowels' F3-F5 (which radiate poorly through the small lip opening) rang with 12-16 Hz
//! bandwidths, with the glottis closed, and stood as tall narrow peaks: VocalSet's singers have
//! 5-25 dB less there. With both losses growing as sqrt(f) the same peaks are 26-49 Hz wide (male)
//! and 30-45 Hz (female). See docs/vocalset.md.
use chimera::airway::frequency::{find_peaks, transfer_function};
use chimera::anatomy::human::{BODY_FEMALE, BODY_MALE, HumanBody, NEUTRAL};
use chimera::phonetics::planner::vowel_table;
use chimera::voice::human_airway::HumanAirway;

/// The narrowest -3 dB bandwidth among the peaks of |U_radiated / U_glottis| between 2 and 5.5
/// kHz that stand within 15 dB of the tallest peak, glottis closed.
fn narrowest_high_peak(body: HumanBody, name: &str, ipa: &str) -> f64 {
    let freqs: Vec<f64> = (0..1580).map(|i| 100.0 + 5.0 * i as f64).collect();
    let mut air = HumanAirway::new(96000.0, body);
    air.apply(&vowel_table()[name][ipa].artic.apply_to(&NEUTRAL), 0.0);
    let h = transfer_function(&air.net.linear_elements(), air.pharynx.first_node(), &freqs, &[air.glottis_port]);
    let peaks = find_peaks(&freqs, &h.mag, 150.0);
    let top = peaks.iter().map(|p| p.db).fold(f64::MIN, f64::max);
    peaks.iter().filter(|p| p.freq > 2000.0 && p.freq < 5500.0 && p.db > top - 15.0 && p.bw.is_finite()).map(|p| p.bw).fold(f64::MAX, f64::min)
}

#[test]
fn rounded_vowels_high_peaks_are_not_needle_thin() {
    for (body, name) in [(BODY_MALE, "male"), (BODY_FEMALE, "female")] {
        for ipa in ["o", "u"] {
            let bw = narrowest_high_peak(body, name, ipa);
            assert!(bw > 22.0, "{name} {ipa}: a 2-5.5 kHz peak is only {bw:.0} Hz wide");
        }
    }
}
