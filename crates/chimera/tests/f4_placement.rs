//! F4 of the adult bodies sits where the VocalSet singers' speech puts it.
//!
//! The vowel calibration fits F1-F3 only, and F4 is set by the body (pharynx length, epilarynx),
//! not the articulation. Before this test the male F4 sat near 3.8 kHz and the female near
//! 4.5-4.8 kHz, and both were often the strongest peak of the tract. LPC on 11 men and 9 women
//! speaking the same text put F4 at 2.9-3.9 kHz (median 3.05) and 3.9-4.05 kHz. See
//! docs/vocalset.md.
use chimera::airway::frequency::{find_peaks, transfer_function};
use chimera::anatomy::human::{BODY_FEMALE, BODY_MALE, HumanBody, NEUTRAL};
use chimera::phonetics::planner::vowel_table;
use chimera::voice::human_airway::HumanAirway;

/// Mean over a e i o u of the 4th resonance of |U_radiated / U_glottis|, glottis closed.
fn mean_f4(body: HumanBody, name: &str, epilarynx: f64) -> f64 {
    let freqs: Vec<f64> = (0..1580).map(|i| 100.0 + 5.0 * i as f64).collect();
    let mut sum = 0.0;
    for ipa in ["ɑ", "e", "i", "o", "u"] {
        let mut air = HumanAirway::new(96000.0, body);
        let mut a = vowel_table()[name][ipa].artic.apply_to(&NEUTRAL);
        a.epilarynx = epilarynx;
        air.apply(&a, 0.0);
        let el = air.net.linear_elements();
        let h = transfer_function(&el, air.pharynx.first_node(), &freqs, &[air.glottis_port]);
        sum += find_peaks(&freqs, &h.mag, 150.0)[3].freq;
    }
    sum / 5.0
}

#[test]
fn male_f4_matches_spoken_reference() {
    let f4 = mean_f4(BODY_MALE, "male", 0.0);
    assert!((3000.0..3450.0).contains(&f4), "male F4 {f4:.0} Hz");
}

#[test]
fn female_f4_matches_spoken_reference() {
    let f4 = mean_f4(BODY_FEMALE, "female", 0.0);
    assert!((3800.0..4250.0).contains(&f4), "female F4 {f4:.0} Hz");
}

/// The singers' long tones peak at 3.0-3.3 kHz (men) and 3.4-3.8 kHz (women): a narrowed
/// epilarynx reaches that range from the spoken F4, so the ring gene still has room to work.
#[test]
fn narrowed_epilarynx_reaches_the_sung_range() {
    let m = mean_f4(BODY_MALE, "male", 1.0);
    let f = mean_f4(BODY_FEMALE, "female", 1.0);
    assert!((2800.0..3300.0).contains(&m), "male F4 at full narrowing {m:.0} Hz");
    assert!((3400.0..3850.0).contains(&f), "female F4 at full narrowing {f:.0} Hz");
}
