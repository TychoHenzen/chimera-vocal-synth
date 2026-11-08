//! Prints how lyrics are syllabified and timed when sung: `cargo run --release -q -p chimera --example plan_dump -- <cmudict.txt> "lyrics" [beats-per-syllable] [bpm] [body]`.
use chimera::anatomy::human::BodyMix;
use chimera::phonetics::english::EnglishG2P;
use chimera::phonetics::sing::{SongOptions, SungNote, plan_song};
use chimera::phonetics::syllables::lyrics_to_syllables;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let dict = std::fs::read_to_string(&a[1]).expect("dict");
    let lyrics = &a[2];
    let beats: f64 = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(1.0);
    let bpm: f64 = a.get(4).and_then(|s| s.parse().ok()).unwrap_or(90.0);
    let body: BodyMix = a.get(5).map_or("male", |s| s.as_str()).into();
    let mut g = EnglishG2P::new();
    g.load_dict(&dict);
    let syl = lyrics_to_syllables(lyrics, &g);
    for s in &syl {
        let j = |v: &Vec<chimera::phonetics::Segment>| v.iter().map(|x| x.ipa.as_str()).collect::<Vec<_>>().join(" ");
        println!("{:8} [{}] ({}) [{}]{}", s.text, j(&s.onset), s.nucleus.ipa, j(&s.coda), if s.phrase_end { " |" } else { "" });
    }
    let notes: Vec<SungNote> = syl.iter().map(|s| SungNote { midi: 64.0, beats, syl: s.clone() }).collect();
    let plan = plan_song(&notes, &SongOptions { body, bpm, t0: 0.3, vibrato: 35.0 });
    for s in &plan.segments {
        println!("{:6.3}-{:6.3} {:3} {}", s.t0, s.t1, s.ipa, s.kind);
    }
}
