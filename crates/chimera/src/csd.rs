//! Note annotations in the Children's Song Dataset format (Choi et al., ISMIR 2020): a CSV of
//! `start,end,pitch,syllable` rows, the syllable's phonemes joined with `_` in CSD's romanisation.
//! They become sung syllables in the engine's IPA, so a render sings exactly the phonemes the
//! recording's singer sang, on her timing and pitch.

use crate::phonetics::{Segment, Syllable};
use serde::{Deserialize, Serialize};

/// A gap between notes longer than this (s) ends a phrase: the synth stops and breathes.
pub const PHRASE_GAP: f64 = 0.08;
/// Two notes this close (s) with a vowel-only second syllable on the same vowel are a melisma.
pub const MELISMA_GAP: f64 = 0.02;

/// CSD's phoneme romanisation to engine IPA, and whether it is a vowel.
pub fn csd_ipa(sym: &str) -> Option<(&'static str, bool)> {
    Some(match sym {
        "a" => ("ɑ", true),
        "ae" => ("æ", true),
        "ai" => ("aɪ", true),
        "ao" => ("ʌ", true),
        "au" => ("aʊ", true),
        "e" => ("ɛ", true),
        "ei" => ("eɪ", true),
        "eo" => ("ə", true),
        "er" => ("ɝ", true),
        "i" => ("ɪ", true),
        "ii" => ("i", true),
        "oi" => ("ɔɪ", true),
        "oo" => ("ɔ", true),
        "ou" => ("oʊ", true),
        "u" => ("ʊ", true),
        "uu" => ("u", true),
        "b" => ("b", false),
        "ch" => ("tʃ", false),
        "d" => ("d", false),
        "dh" => ("ð", false),
        "f" => ("f", false),
        "g" => ("g", false),
        "h" => ("h", false),
        "j" => ("dʒ", false),
        "k" => ("k", false),
        "l" => ("l", false),
        "m" => ("m", false),
        "n" => ("n", false),
        "ng" => ("ŋ", false),
        "p" => ("p", false),
        "r" => ("ɹ", false),
        "s" => ("s", false),
        "sh" => ("ʃ", false),
        "t" => ("t", false),
        "th" => ("θ", false),
        "v" => ("v", false),
        "w" => ("w", false),
        "y" => ("j", false),
        "z" => ("z", false),
        "zh" => ("ʒ", false),
        _ => return None,
    })
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub start: f64,
    pub end: f64,
    pub midi: f64,
    /// the CSD syllable as written (`k_y_uu`)
    pub csd: String,
    pub syl: Syllable,
    /// first note after a phrase gap (or of the song)
    pub phrase_start: bool,
    /// end of the previous note (-inf for the first, written as null in JSON)
    #[serde(with = "neg_inf")]
    pub prev_end: f64,
}

mod neg_inf {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(v: &f64, s: S) -> Result<S::Ok, S::Error> {
        if v.is_finite() { s.serialize_f64(*v) } else { s.serialize_none() }
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
        Ok(Option::<f64>::deserialize(d)?.unwrap_or(f64::NEG_INFINITY))
    }
}

/// Read a CSD notes file's text (`what` names it in errors) into notes with engine syllables,
/// melismas and phrase ends.
pub fn parse(text: &str, what: &str) -> Result<Vec<Note>, String> {
    let mut notes: Vec<Note> = Vec::new();
    let mut unknown: Vec<String> = Vec::new();
    for (ln, line) in text.lines().enumerate().skip(1) {
        let f: Vec<&str> = line.trim().split(',').collect();
        if f.len() < 4 {
            continue;
        }
        let parse = |s: &str| s.trim().parse::<f64>().map_err(|e| format!("{what}:{}: {e}", ln + 1));
        let (start, end, midi) = (parse(f[0])?, parse(f[1])?, parse(f[2])?);
        let csd = f[3].trim().to_string();
        let mut onset = Vec::new();
        let mut nucleus: Option<Segment> = None;
        let mut coda = Vec::new();
        for p in csd.split('_').filter(|p| !p.is_empty()) {
            let Some((ipa, vowel)) = csd_ipa(p) else {
                unknown.push(format!("{p} (in {csd}, line {})", ln + 1));
                continue;
            };
            match (&nucleus, vowel) {
                (None, true) => nucleus = Some(Segment::new(ipa)),
                (None, false) => onset.push(Segment::new(ipa)),
                // a second vowel in one syllable sings as part of the coda
                (Some(_), _) => coda.push(Segment::new(ipa)),
            }
        }
        let nucleus = nucleus.unwrap_or_else(|| Segment::new("ə"));
        notes.push(Note {
            start,
            end,
            midi,
            csd: csd.clone(),
            syl: Syllable { text: csd, onset, nucleus, coda, melisma: None, word_end: true, phrase_end: false },
            phrase_start: false,
            prev_end: f64::NEG_INFINITY,
        });
    }
    if !unknown.is_empty() {
        return Err(format!("{what}: unmapped CSD phonemes: {}", unknown.join(", ")));
    }
    let n = notes.len();
    for i in 0..n {
        let gap_after = if i + 1 < n { notes[i + 1].start - notes[i].end } else { f64::INFINITY };
        notes[i].syl.phrase_end = gap_after > PHRASE_GAP;
        notes[i].phrase_start = i == 0 || notes[i - 1].syl.phrase_end;
        if i > 0 {
            notes[i].prev_end = notes[i - 1].end;
        }
        if i > 0 && !notes[i].phrase_start {
            let (prev, cur) = (&notes[i - 1], &notes[i]);
            let melisma = cur.syl.onset.is_empty()
                && cur.syl.coda.is_empty()
                && cur.syl.nucleus.ipa == prev.syl.nucleus.ipa
                && cur.start - prev.end < MELISMA_GAP;
            if melisma {
                // plan_song holds the chain's first coda until its last note
                notes[i].syl.melisma = Some(true);
            }
        }
    }
    Ok(notes)
}
