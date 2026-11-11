//! A voice found by Evolve, as settings any human voice can take: the source's fine tuning, the
//! body's dimensions relative to the singer's, the source settings the song planner leaves alone,
//! and an offset on every full vowel. Evolve's renderer and the live engine both apply it through
//! this module, so a voice sounds the same on the Evolve page and on the instrument.
//!
//! Built from Evolve's genes by name. Genes the live voice cannot play are not part of it: the
//! output level, lung pressure, vibrato and drift belong to the performer's controls, and the
//! loudness shapes and timing are per note of the recording.

use crate::anatomy::human::{ArticKey, BodyName, HumanBody};
use crate::control::score::Gesture;
use crate::phonetics::vowel_data::VOWELS;
use crate::voice::human_voice::{SourcePatch, VoiceTuning};

/// Articulators whose vowel targets get an offset. Only keys the vowel targets actually carry: an
/// offset on a key a target lacks would never apply.
pub const VOWEL_KEYS: [ArticKey; 8] = [
    ArticKey::Jaw,
    ArticKey::TbX,
    ArticKey::TbY,
    ArticKey::Root,
    ArticKey::LipAp,
    ArticKey::LipProt,
    ArticKey::LipWidth,
    ArticKey::Larynx,
];

/// The body's dimensions as differences from the singer's own body.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BodyDelta {
    pub scale: f64,
    pub pharynx: f64,
    pub tongue_radius: f64,
    pub lip_width: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VoiceProfile {
    pub tuning: VoiceTuning,
    pub body: BodyDelta,
    /// added to every full-strength vowel target, in `VOWEL_KEYS` order
    pub vowel: [f64; 8],
    /// epilarynx narrowing held through every vowel (0 wide, 1 narrowest)
    pub epilarynx: f64,
    /// tension, breathiness, roughness, fry, glide, brightness (the rest stay `None`)
    pub source: SourcePatch,
}

impl Default for VoiceProfile {
    fn default() -> Self {
        VoiceProfile { tuning: VoiceTuning::default(), body: BodyDelta::default(), vowel: [0.0; 8], epilarynx: 0.0, source: SourcePatch::default() }
    }
}

impl VoiceProfile {
    /// From Evolve's genes (decoded values, by name) for a voice evolved on `base`. Unknown names
    /// are ignored; a missing gene keeps the default voice's value.
    pub fn from_named<'a>(genes: impl IntoIterator<Item = (&'a str, f64)>, base: BodyName) -> VoiceProfile {
        let b = base.body();
        let mut p = VoiceProfile::default();
        for (name, v) in genes {
            if !v.is_finite() {
                continue;
            }
            let t = &mut p.tuning;
            match name {
                "chink_scale" => t.chink_scale = v,
                "open_quotient_add" => t.open_quotient_add = v,
                "skew_add" => t.skew_add = v,
                "sharpness_add" => t.sharpness_add = v,
                "jitter_scale" => t.jitter_scale = v,
                "shimmer_scale" => t.shimmer_scale = v,
                "smooth_wave" => t.smooth_wave = v,
                "wave_gain" => t.wave_gain = v,
                "pressure_scale" => t.pressure_scale = v,
                "viscous_scale" => t.viscous_scale = v,
                "wall_damping_scale" => t.wall_damping_scale = v,
                "aspiration_scale" => t.aspiration_scale = v,
                "aspiration_hz" => t.aspiration_hz = v,
                "return_time_ms" => t.return_time = 0.001 * v,
                "body_scale" => p.body.scale = v - b.scale,
                "body_pharynx" => p.body.pharynx = v - b.pharynx,
                "body_tongue_radius" => p.body.tongue_radius = v - b.tongue_radius,
                "body_lip_width" => p.body.lip_width = v - b.lip_width,
                "tension" => p.source.tension = Some(v),
                "breathiness" => p.source.breathiness = Some(v),
                "roughness" => p.source.roughness = Some(v),
                "fry" => p.source.fry = Some(v),
                "pitch_glide_s" => p.source.glide = Some(v),
                "brightness" => p.source.brightness = Some(v),
                "epilarynx" => p.epilarynx = v,
                _ => {
                    if let Some(k) = name.strip_prefix("vowel_").and_then(ArticKey::from_name)
                        && let Some(i) = VOWEL_KEYS.iter().position(|x| *x == k)
                    {
                        p.vowel[i] = v;
                    }
                }
            }
        }
        p
    }

    /// True when applying it to the gestures would change nothing.
    pub fn neutral_vowels(&self) -> bool {
        self.epilarynx == 0.0 && self.vowel.iter().all(|v| *v == 0.0)
    }

    /// The singer's body with this voice's dimensions.
    pub fn body_for(&self, b: HumanBody) -> HumanBody {
        HumanBody {
            name: b.name,
            scale: b.scale + self.body.scale,
            pharynx: b.pharynx + self.body.pharynx,
            tongue_radius: b.tongue_radius + self.body.tongue_radius,
            lip_width: b.lip_width + self.body.lip_width,
        }
    }

    /// Shift every full-strength vowel gesture's targets by the offsets, and hold the epilarynx.
    /// Allocates nothing.
    pub fn apply_to_vowels(&self, gestures: &mut [Gesture]) {
        for g in gestures.iter_mut() {
            if g.strength < 0.999 || !g.label.is_some_and(|l| is_vowel_label(l.as_str())) {
                continue;
            }
            for (i, k) in VOWEL_KEYS.iter().enumerate() {
                if let Some(t) = g.targets.get(*k) {
                    g.targets.set(*k, t + self.vowel[i]);
                }
            }
            // ASSUMPTION: the vowel targets never set the epilarynx, so this is an absolute value
            // held through every vowel; consonants keep the wide default.
            let base = g.targets.get(ArticKey::Epilarynx).unwrap_or(0.0);
            g.targets.set(ArticKey::Epilarynx, (base + self.epilarynx).clamp(0.0, 1.0));
        }
    }
}

pub fn is_vowel_label(s: &str) -> bool {
    VOWELS.iter().any(|v| v.ipa == s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control::score::Targets;

    #[test]
    fn default_genes_change_nothing() {
        let names = [("chink_scale", 1.0), ("body_scale", BodyName::Female.body().scale), ("tension", 0.55), ("gain_db", 6.0), ("dyn_mid_db", 4.0)];
        let p = VoiceProfile::from_named(names, BodyName::Female);
        assert_eq!(p.tuning, VoiceTuning::default(), "gain_db belongs to the volume control");
        assert_eq!(p.body, BodyDelta::default());
        assert!(p.neutral_vowels());
        assert_eq!(p.source.tension, Some(0.55));
        assert_eq!(p.source.pressure, None, "lung pressure belongs to the performer");
    }

    #[test]
    fn body_genes_move_any_singer_by_the_same_amount() {
        let f = BodyName::Female.body();
        let p = VoiceProfile::from_named([("body_pharynx", f.pharynx + 0.1)], BodyName::Female);
        let m = BodyName::Male.body();
        assert!((p.body_for(m).pharynx - (m.pharynx + 0.1)).abs() < 1e-12);
    }

    #[test]
    fn offsets_touch_only_full_vowels() {
        let p = VoiceProfile::from_named([("vowel_jaw", 0.1), ("epilarynx", 0.5)], BodyName::Male);
        let t = Targets::default().with(ArticKey::Jaw, 1.0);
        let mut gs = [Gesture::new(0.0, 1.0, 0.0, 0.0, 1.0, t).label("a"), Gesture::new(0.0, 1.0, 0.0, 0.0, 1.0, t).label("t"), Gesture::new(0.0, 1.0, 0.0, 0.0, 0.5, t).label("a")];
        p.apply_to_vowels(&mut gs);
        assert!((gs[0].targets.get(ArticKey::Jaw).unwrap() - 1.1).abs() < 1e-12);
        assert_eq!(gs[0].targets.get(ArticKey::Epilarynx), Some(0.5));
        assert_eq!(gs[1].targets.get(ArticKey::Jaw), Some(1.0));
        assert_eq!(gs[2].targets.get(ArticKey::Jaw), Some(1.0));
        assert_eq!(gs[2].targets.get(ArticKey::Epilarynx), None);
    }
}
