//! `chimera evolve`: tune the synthesiser to recordings (the engine is in `chimera::evolve`;
//! the web app's Evolve mode drives the same code through wasm workers).
//!
//! By default it rotates: every `--rotate` minutes (30) it moves to the next phrase of the next
//! training song (CSD songs whose number is not a multiple of five), keeping the voice genes
//! (glottis, body, loudness shape, vowel articulation) and restarting the per-note genes
//! (timing, pitch, vowel, level), so what survives is what holds across songs. The songs whose
//! number is a multiple of five are never trained on: at every rotation the carried voice is
//! scored on a few of their phrases against the default voice, which is the generalisation graph.
//! `--song en042a --notes 0-6` trains on one phrase instead.
//!
//! Output (in `--out`): `log.jsonl`, `state.json` (resume with `--resume`), `voice.json` (the
//! carried voice genes), `best.json`, `best.wav`, `ref.wav`, `dashboard.html`.

use crate::compare::{Note, load_notes, read_wav};
use crate::{Ctx, repo_path};
use chimera::evolve::{BANDS, COMP_NAMES, Cma, Eval, N_COMP, Problem, Spec};
use serde_json::{Value, json};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

/// Phrase lengths trained on (the genome has five genes per note).
const MAX_NOTES: usize = 14;
const MIN_NOTES: usize = 4;
/// Held-out phrases scored at each rotation.
const HELD_OUT: usize = 4;

struct Args {
    song: Option<String>,
    first: usize,
    last: usize,
    pop: usize,
    gens: Option<usize>,
    minutes: f64,
    rotate: f64,
    out: String,
    resume: Option<String>,
    jobs: usize,
    seed: u64,
    sigma: f64,
    /// Step multiplier of the voice genes while a phrase rotates (the notes keep 1).
    voice_scale: f64,
}

/// Share of a finished phrase's voice that moves the shared voice: 1/(n+2) after n phrases (a running
/// mean, so the voice settles as phrases accumulate), but never below `VOICE_RATE_FLOOR`, so it can
/// still follow a lasting trend.
const VOICE_RATE_FLOOR: f64 = 0.04;

fn voice_rate(absorbed: usize) -> f64 {
    (1.0 / (absorbed as f64 + 2.0)).max(VOICE_RATE_FLOOR)
}

fn parse(a: &[String]) -> Result<Args, String> {
    let mut o = Args {
        song: None,
        first: 0,
        last: 6,
        pop: 32,
        gens: None,
        minutes: 0.0,
        rotate: 30.0,
        out: String::new(),
        resume: None,
        jobs: std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4),
        seed: 1,
        sigma: 0.2,
        voice_scale: 0.25,
    };
    let mut i = 0;
    while i < a.len() {
        let key = a[i].as_str();
        let val = a.get(i + 1).ok_or_else(|| format!("{key} needs a value"))?;
        let num = |s: &str| s.parse::<f64>().map_err(|e| format!("{key}: {e}"));
        match key {
            "--song" => o.song = Some(val.clone()),
            "--notes" => {
                let (x, y) = val.split_once('-').ok_or("--notes wants first-last, like 0-6")?;
                o.first = x.parse().map_err(|e| format!("--notes: {e}"))?;
                o.last = y.parse().map_err(|e| format!("--notes: {e}"))?;
            }
            "--pop" => o.pop = num(val)? as usize,
            "--gens" => o.gens = Some(num(val)? as usize),
            "--minutes" => o.minutes = num(val)?,
            "--rotate" => o.rotate = num(val)?,
            "--out" => o.out = val.clone(),
            "--resume" => o.resume = Some(val.clone()),
            "--jobs" => o.jobs = (num(val)? as usize).max(1),
            "--seed" => o.seed = num(val)? as u64,
            "--sigma" => o.sigma = num(val)?,
            "--voice-scale" => o.voice_scale = num(val)?.clamp(0.01, 1.0),
            _ => return Err(format!("unknown evolve option {key}")),
        }
        i += 2;
    }
    if o.pop < 4 {
        return Err("--pop must be at least 4".into());
    }
    if o.song.is_some() {
        // one named phrase: no rotation
        o.rotate = 0.0;
    }
    if o.out.is_empty() {
        o.out = repo_path(&format!("out/evolve/{}", o.song.as_deref().unwrap_or("rotating")));
    }
    Ok(o)
}

#[derive(Clone, Debug)]
struct Phrase {
    song: String,
    first: usize,
    last: usize,
}

impl Phrase {
    fn label(&self) -> String {
        format!("{} notes {}-{}", self.song, self.first, self.last)
    }
}

const BASE: &str = "voiceRef/CSD/english";

fn load_problem(p: &Phrase) -> Result<Problem, String> {
    let base = repo_path(BASE);
    let all = load_notes(&format!("{base}/csv/{}.csv", p.song))?;
    let (wav, rate) = read_wav(&format!("{base}/wav/{}.wav", p.song))?;
    let mut prob = Problem::new(&all, p.first, p.last, &wav, rate, 0.0)?;
    // A/B switch: CHIMERA_NO_FOLLOW_PITCH=1 sings the notes' pitch instead of the recording's contour.
    if std::env::var_os("CHIMERA_NO_FOLLOW_PITCH").is_some() {
        prob.f0_track.clear();
    }
    // debugging: CHIMERA_F0_SCALE=<ratio> and CHIMERA_F0_SHIFT=<hops> move the contour
    if let Some(s) = std::env::var("CHIMERA_F0_SCALE").ok().and_then(|s| s.parse::<f64>().ok()) {
        for h in prob.f0_track.iter_mut() {
            *h *= s;
        }
    }
    if let Some(s) = std::env::var("CHIMERA_F0_SHIFT").ok().and_then(|s| s.parse::<i32>().ok()) {
        let n = prob.f0_track.len() as i32;
        let old = prob.f0_track.clone();
        for i in 0..n {
            prob.f0_track[i as usize] = old.get((i - s).max(0) as usize).copied().unwrap_or(0.0);
        }
    }
    // debugging: CHIMERA_DUMP_F0=<file> writes the contour and the notes it was checked against
    if let Some(path) = std::env::var_os("CHIMERA_DUMP_F0") {
        let notes: Vec<String> = prob.notes.iter().map(|n| format!("[{:.3},{:.3},{:.2}]", n.start, n.end, n.midi)).collect();
        let _ = std::fs::write(path, format!("{{\"hop\":0.01,\"notes\":[{}],\"f0\":{:?}}}", notes.join(","), prob.f0_track));
    }
    Ok(prob)
}

/// Every whole phrase of a song that is neither a scrap nor too long to fit in a genome.
/// (Cutting a phrase in the middle starts the recording inside a word the notes do not have.)
fn phrases_of(song: &str, notes: &[Note]) -> Vec<Phrase> {
    let mut out = Vec::new();
    let mut a = 0;
    for (i, n) in notes.iter().enumerate() {
        if n.syl.phrase_end || i + 1 == notes.len() {
            let len = i + 1 - a;
            if (MIN_NOTES..=MAX_NOTES).contains(&len) {
                out.push(Phrase { song: song.into(), first: a, last: i });
            }
            a = i + 1;
        }
    }
    out
}

/// Songs are named `enNNNx`; those whose number is a multiple of five are held out.
fn held_out(song: &str) -> bool {
    song.get(2..5).and_then(|n| n.parse::<u32>().ok()).is_some_and(|n| n % 5 == 0)
}

fn scramble(seed: u64, i: usize) -> u64 {
    let mut z = seed.wrapping_add((i as u64 + 1).wrapping_mul(0x9E37_79B9_7F4A_7C15));
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// (training phrases in rotation order, held-out phrases)
fn plan(args: &Args) -> Result<(Vec<Phrase>, Vec<Phrase>), String> {
    if let Some(song) = &args.song {
        return Ok((vec![Phrase { song: song.clone(), first: args.first, last: args.last }], Vec::new()));
    }
    let dir = repo_path(&format!("{BASE}/csv"));
    let mut songs: Vec<String> = std::fs::read_dir(&dir)
        .map_err(|e| format!("{dir}: {e}"))?
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().to_str().and_then(|n| n.strip_suffix(".csv")).map(String::from))
        .collect();
    songs.sort();
    let (mut train, mut test) = (Vec::new(), Vec::new());
    for s in &songs {
        let notes = load_notes(&format!("{dir}/{s}.csv"))?;
        let ps = phrases_of(s, &notes);
        if held_out(s) { test.extend(ps) } else { train.extend(ps) }
    }
    if train.is_empty() {
        return Err(format!("no training phrases under {dir}"));
    }
    // the order is a seeded shuffle, so a segment is rarely followed by the same song
    let mut keyed: Vec<(u64, Phrase)> = train.into_iter().enumerate().map(|(i, p)| (scramble(args.seed, i), p)).collect();
    keyed.sort_by_key(|k| k.0);
    let train: Vec<Phrase> = keyed.into_iter().map(|k| k.1).collect();
    let step = (test.len() / HELD_OUT).max(1);
    let test: Vec<Phrase> = test.into_iter().step_by(step).take(HELD_OUT).collect();
    Ok((train, test))
}

fn evaluate_all(p: &Problem, xs: &[Vec<f64>], jobs: usize) -> Vec<Eval> {
    let next = AtomicUsize::new(0);
    let results: Mutex<Vec<Option<Eval>>> = Mutex::new(vec![None; xs.len()]);
    std::thread::scope(|s| {
        for _ in 0..jobs.min(xs.len()) {
            s.spawn(|| {
                loop {
                    let i = next.fetch_add(1, Ordering::SeqCst);
                    if i >= xs.len() {
                        break;
                    }
                    let e = p.evaluate(&xs[i]);
                    results.lock().unwrap()[i] = Some(e);
                }
            });
        }
    });
    results.into_inner().unwrap().into_iter().map(|e| e.unwrap()).collect()
}

fn write(path: &str, text: &str) -> Result<(), String> {
    std::fs::write(path, text).map_err(|e| format!("{path}: {e}"))
}

/// An output other programs may hold open (a wav in an editor, the dashboard in a browser)
/// must not end a run that can go on for hours: say so and carry on.
fn write_soft(path: &str, text: &str) {
    if let Err(e) = write(path, text) {
        eprintln!("warning: {e}");
    }
}

fn mean(v: &[f64]) -> f64 {
    v.iter().sum::<f64>() / v.len().max(1) as f64
}

/// The default per-note genes with the carried voice genes in front.
fn with_voice(p: &Problem, voice: Option<&[f64]>) -> Vec<f64> {
    let mut x = p.spec.start();
    if let Some(v) = voice {
        x[..v.len()].copy_from_slice(v);
    }
    x
}

pub fn run(ctx: &Ctx, a: &[String]) -> Result<(), String> {
    let args = parse(a)?;
    let dir = args.out.clone();
    std::fs::create_dir_all(&dir).map_err(|e| format!("{dir}: {e}"))?;
    let (train, test) = plan(&args)?;
    let held: Vec<Problem> = test.iter().map(load_problem).collect::<Result<_, _>>()?;
    let g = Spec::n_global();
    println!("{} training phrases, {} held-out phrases", train.len(), held.len());

    // The shared voice: moves slowly, one phrase at a time. Everything else (notes) restarts per phrase.
    let mut carry: Option<Vec<f64>> = None;
    let mut absorbed = 0usize;
    let mut seg = 0usize;
    let mut segments: Vec<Value> = Vec::new();
    let mut history: Vec<Value> = Vec::new();
    let mut evals = 0usize;
    let mut elapsed_prev = 0.0;
    let mut resume: Option<Value> = None;
    if let Some(r) = &args.resume {
        let text = std::fs::read_to_string(format!("{r}/state.json")).map_err(|e| format!("{r}/state.json: {e}"))?;
        let s: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        seg = s["seg"].as_u64().unwrap_or(0) as usize;
        carry = serde_json::from_value(s["carry"].clone()).ok();
        absorbed = s["absorbed"].as_u64().unwrap_or(0) as usize;
        segments = s["segments"].as_array().cloned().unwrap_or_default();
        history = s["history"].as_array().cloned().unwrap_or_default();
        evals = s["evals"].as_u64().unwrap_or(0) as usize;
        elapsed_prev = s["elapsed"].as_f64().unwrap_or(0.0);
        resume = Some(s);
    }

    let t_start = Instant::now();
    let total = |extra: f64| elapsed_prev + extra;
    let mut gens_done = 0usize;
    let gen_limit = args.gens.unwrap_or(if args.song.is_some() { 200 } else { usize::MAX });
    let mut finished = false;

    while !finished {
        let phrase = train[seg % train.len()].clone();
        let problem = load_problem(&phrase)?;
        let ref_f32: Vec<f32> = problem.reference().iter().map(|&s| s as f32).collect();
        ctx.write_wav(&format!("{dir}/ref.wav"), &ref_f32)?;
        let default_x = problem.spec.start();
        let default_eval = problem.evaluate(&default_x);
        let start_x = with_voice(&problem, carry.as_deref());
        let mut seg_elapsed = 0.0;
        let mut cma: Cma;
        let mut best_x: Vec<f64>;
        let mut best: Eval;

        if let Some(s) = resume.take() {
            // continue the segment the saved run was in
            cma = serde_json::from_value(s["cma"].clone()).map_err(|e| format!("state.json: cma: {e}"))?;
            let c: &Cma = &cma;
            if c.mean.len() != problem.spec.dim() {
                return Err(format!("state.json has {} genes, this run has {}", c.mean.len(), problem.spec.dim()));
            }
            best_x = serde_json::from_value(s["best_x"].clone()).map_err(|e| format!("state.json: {e}"))?;
            best = problem.evaluate(&best_x);
            seg_elapsed = s["seg_elapsed"].as_f64().unwrap_or(0.0);
            println!("resumed segment {seg} ({}) at generation {} (best {:.4})", phrase.label(), cma.generation, best.loss);
        } else {
            let start_eval = problem.evaluate(&start_x);
            let mut entry = json!({
                "seg": seg, "song": phrase.song, "first": phrase.first, "last": phrase.last,
                "default_loss": default_eval.loss, "start_loss": start_eval.loss, "final_loss": start_eval.loss,
                "at": total(t_start.elapsed().as_secs_f64()),
            });
            if carry.is_some() && !held.is_empty() {
                let mut with = 0.0;
                let mut without = 0.0;
                for h in &held {
                    with += h.evaluate(&with_voice(h, carry.as_deref())).loss;
                    without += h.evaluate(&h.spec.start()).loss;
                }
                entry["held_loss"] = json!(with / held.len() as f64);
                entry["held_default"] = json!(without / held.len() as f64);
            }
            println!(
                "segment {seg}: {} - default voice {:.4}, carried voice {:.4}{}",
                phrase.label(),
                default_eval.loss,
                start_eval.loss,
                match (entry["held_loss"].as_f64(), entry["held_default"].as_f64()) {
                    (Some(a), Some(b)) => format!(" - held-out phrases: carried {a:.4}, default {b:.4}"),
                    _ => String::new(),
                }
            );
            segments.push(entry);
            evals += 2 + 2 * held.len() * usize::from(carry.is_some());
            // voice genes take small steps (they are shared); note genes take full steps (they are this phrase's)
            let vs = if args.rotate > 0.0 { args.voice_scale } else { 1.0 };
            let scales: Vec<f64> = (0..start_x.len()).map(|i| if i < g { vs } else { 1.0 }).collect();
            cma = Cma::with_scales(start_x.clone(), args.sigma, args.pop, args.seed.wrapping_add(seg as u64), scales);
            best_x = start_x.clone();
            best = start_eval;
        }

        let mut last_dash = Instant::now() - Duration::from_secs(3600);
        let mut shown_best = f64::INFINITY;
        let mut pictures: Option<(Vec<u8>, Vec<u8>)> = None;
        let seg_start = Instant::now();
        loop {
            let xs = cma.ask();
            let evs = evaluate_all(&problem, &xs, args.jobs);
            evals += xs.len();
            let losses: Vec<f64> = evs.iter().map(|e| e.loss).collect();
            let (bi, _) = losses
                .iter()
                .enumerate()
                .min_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))
                .unwrap();
            let improved = losses[bi] < best.loss;
            if improved {
                best_x = xs[bi].clone();
                best = evs[bi];
            }
            let mut sorted = losses.clone();
            sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let med = sorted[sorted.len() / 2];
            cma.tell(&losses);
            gens_done += 1;
            let this_seg = seg_elapsed + seg_start.elapsed().as_secs_f64();
            let elapsed = total(t_start.elapsed().as_secs_f64());
            let rec = json!({
                "seg": seg, "gen": cma.generation, "evals": evals, "elapsed": elapsed,
                "best": best.loss, "gen_best": sorted[0], "mean": mean(&losses), "median": med,
                "worst": sorted[sorted.len() - 1], "sigma": cma.sigma, "comps": best.comps, "gap_db": best.gap,
                "rel": best.loss / default_eval.loss,
                "x": best_x[..g].iter().map(|v| (v * 1000.0).round() / 1000.0).collect::<Vec<_>>(),
            });
            history.push(rec.clone());
            if let Some(last) = segments.last_mut() {
                last["final_loss"] = json!(best.loss);
            }
            let line = serde_json::to_string(&rec).map_err(|e| e.to_string())?;
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(format!("{dir}/log.jsonl"))
                .map_err(|e| e.to_string())?;
            writeln!(f, "{line}").map_err(|e| e.to_string())?;
            println!(
                "seg {seg:3} gen {:4}  best {:.4} ({:.0}% of default)  gen-best {:.4}  median {:.4}  sigma {:.3}  {:.0}s  ({}) level {:+.1} dB",
                cma.generation,
                best.loss,
                100.0 * best.loss / default_eval.loss,
                sorted[0],
                med,
                cma.sigma,
                elapsed,
                comp_text(&best.comps),
                best.gap,
            );

            let rotate_now = args.rotate > 0.0 && this_seg >= args.rotate * 60.0;
            finished = gens_done >= gen_limit || (args.minutes > 0.0 && elapsed >= args.minutes * 60.0);
            // The voice that goes on to the next phrase: the shared voice moved a fraction of the way
            // toward what this phrase found. The phrase's own notes are dropped.
            let next_carry: Option<Vec<f64>> = if rotate_now {
                let rate = voice_rate(absorbed);
                let base = carry.clone().unwrap_or_else(|| problem.spec.start()[..g].to_vec());
                let merged: Vec<f64> = base.iter().zip(&best_x[..g]).map(|(b, v)| b + rate * (v - b)).collect();
                if let Some(last) = segments.last_mut() {
                    last["voice_rate"] = json!(rate);
                    last["voice_found"] = json!(best_x[..g].iter().map(|v| (v * 1000.0).round() / 1000.0).collect::<Vec<_>>());
                    last["voice_shared"] = json!(merged.iter().map(|v| (v * 1000.0).round() / 1000.0).collect::<Vec<_>>());
                }
                Some(merged)
            } else {
                carry.clone()
            };
            let state = json!({
                "cma": cma, "best_x": best_x, "best_loss": best.loss, "evals": evals, "elapsed": elapsed,
                "history": history, "seg": seg, "seg_elapsed": this_seg, "segments": segments,
                "carry": next_carry,
                "absorbed": absorbed + usize::from(rotate_now),
            });
            write_soft(&format!("{dir}/state.json"), &state.to_string());

            let end = finished || rotate_now;
            let due = last_dash.elapsed().as_secs() >= 20;
            if (improved && best.loss < shown_best - 1e-9 && due) || end {
                shown_best = best.loss;
                last_dash = Instant::now();
                let out = problem.render(&best_x);
                if let Err(e) = ctx.write_wav(&format!("{dir}/best.wav"), &out) {
                    eprintln!("warning: {e}");
                }
                pictures = Some(problem.pictures(&out));
                if end {
                    save_pair(ctx, &dir, seg, &phrase, &problem, &out, &best);
                }
                write_soft(&format!("{dir}/best.json"), &best_json(&problem, &best_x, &best, &phrase));
                let mut shared = best_x.clone();
                if let Some(v) = &next_carry {
                    shared[..g].copy_from_slice(v);
                }
                write_soft(&format!("{dir}/voice.json"), &voice_json(&problem, &shared));
                write_soft(&format!("{dir}/dashboard.html"), &dashboard(&problem, &history, &segments, pictures.as_ref(), &phrase, &best, finished));
            } else if due && pictures.is_some() {
                last_dash = Instant::now();
                write_soft(&format!("{dir}/dashboard.html"), &dashboard(&problem, &history, &segments, pictures.as_ref(), &phrase, &best, false));
            }
            if end {
                if rotate_now {
                    carry = next_carry;
                    absorbed += 1;
                }
                break;
            }
        }
        seg += 1;
    }
    println!("done after {} segments; open {dir}/dashboard.html", seg);
    Ok(())
}

/// Keep the recording and the evolved render of a finished phrase side by side, in `pairs/`.
fn save_pair(ctx: &Ctx, dir: &str, seg: usize, phrase: &Phrase, p: &Problem, best_wav: &[f32], best: &Eval) {
    let pd = format!("{dir}/pairs");
    if let Err(e) = std::fs::create_dir_all(&pd) {
        eprintln!("warning: {pd}: {e}");
        return;
    }
    let name = format!("{seg:04}_{}_{}-{}", phrase.song, phrase.first, phrase.last);
    let ref_f32: Vec<f32> = p.reference().iter().map(|&s| s as f32).collect();
    for (suffix, wav) in [("ref", &ref_f32[..]), ("best", best_wav)] {
        if let Err(e) = ctx.write_wav(&format!("{pd}/{name}_{suffix}.wav"), wav) {
            eprintln!("warning: {e}");
        }
    }
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(format!("{pd}/pairs.jsonl")) {
        let _ = writeln!(f, "{}", json!({"seg": seg, "name": name, "loss": best.loss, "level_gap_db": best.gap}));
    }
}

fn comp_text(c: &[f64; N_COMP]) -> String {
    COMP_NAMES.iter().zip(c).map(|(n, v)| format!("{n} {v:.3}")).collect::<Vec<_>>().join(", ")
}

fn best_json(p: &Problem, x: &[f64], best: &Eval, phrase: &Phrase) -> String {
    let v = p.spec.decode(x);
    let genes: Vec<Value> = p
        .spec
        .genes
        .iter()
        .enumerate()
        .map(|(i, g)| json!({"name": g.name, "value": v[i], "default": g.def, "lo": g.lo, "hi": g.hi, "unit": x[i]}))
        .collect();
    serde_json::to_string_pretty(&json!({
        "song": phrase.song, "notes": [phrase.first, phrase.last], "loss": best.loss,
        "components": COMP_NAMES.iter().zip(best.comps).map(|(n, c)| json!({"name": n, "value": c})).collect::<Vec<_>>(),
        "sung_vowels": p.spec.sung_vowels(x), "genes": genes,
    }))
    .unwrap_or_default()
}

/// Only the voice genes, the part that is not about one phrase.
fn voice_json(p: &Problem, x: &[f64]) -> String {
    let v = p.spec.decode(x);
    let genes: Vec<Value> = p.spec.genes[..Spec::n_global()]
        .iter()
        .enumerate()
        .map(|(i, g)| json!({"name": g.name, "value": v[i], "default": g.def, "lo": g.lo, "hi": g.hi}))
        .collect();
    serde_json::to_string_pretty(&json!({ "genes": genes })).unwrap_or_default()
}

fn dashboard(
    p: &Problem,
    history: &[Value],
    segments: &[Value],
    pictures: Option<&(Vec<u8>, Vec<u8>)>,
    phrase: &Phrase,
    best: &Eval,
    done: bool,
) -> String {
    let (sim, rf) = match pictures {
        Some((s, r)) => (s.clone(), r.clone()),
        None => (Vec::new(), Vec::new()),
    };
    let data = json!({
        "title": phrase.label(),
        "done": done,
        "bands": BANDS,
        "names": p.spec.genes[..Spec::n_global()].iter().map(|g| g.name.clone()).collect::<Vec<_>>(),
        "comp_names": COMP_NAMES,
        "log": history.iter().map(|h| json!({
            "seg": h["seg"], "gen": h["gen"], "elapsed": h["elapsed"], "best": h["best"], "gen_best": h["gen_best"], "mean": h["mean"],
            "median": h["median"], "worst": h["worst"], "sigma": h["sigma"], "comps": h["comps"], "gap": h["gap_db"], "rel": h["rel"], "x": h["x"],
        })).collect::<Vec<_>>(),
        "segments": segments,
        "best": best.loss,
        "sim": sim, "ref": rf,
        "seconds": p.seconds,
    });
    let refresh = if done { "" } else { "<meta http-equiv=\"refresh\" content=\"20\">" };
    DASH.replace("__REFRESH__", refresh).replace("__DATA__", &data.to_string())
}

const DASH: &str = r##"<!doctype html>
<html lang="en"><head><meta charset="utf-8">__REFRESH__
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Voice evolution</title>
<style>
:root{--bg:#fff;--fg:#1b1f24;--mute:#6a737d;--grid:#e1e4e8;--c1:#1f77b4;--c2:#ff7f0e;--c3:#2ca02c;--c4:#d62728;--c5:#9467bd;--card:#f6f8fa}
@media(prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--mute:#8b949e;--grid:#30363d;--c1:#58a6ff;--c2:#f0883e;--c3:#56d364;--c4:#ff7b72;--c5:#bc8cff;--card:#161b22}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.4 system-ui,sans-serif}
h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;margin:0 0 6px;color:var(--mute);font-weight:600}
.sub{color:var(--mute);margin-bottom:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:14px}
.card{background:var(--card);border-radius:8px;padding:12px}
canvas{width:100%;display:block}
table{border-collapse:collapse;width:100%;font-size:12px}td,th{padding:2px 6px;border-bottom:1px solid var(--grid);text-align:right}
td:first-child,th:first-child{text-align:left}
.legend span{margin-right:12px}.legend i{display:inline-block;width:10px;height:10px;margin-right:4px;border-radius:2px}
</style></head><body>
<h1>Voice evolution</h1><div class="sub" id="sub"></div>
<div class="grid">
<div class="card"><h2>Loss per generation (log scale); dashed lines mark a switch to the next phrase</h2><canvas id="loss" height="260"></canvas>
<div class="legend"><span><i style="background:var(--c1)"></i>best so far</span><span><i style="background:var(--c2)"></i>generation best</span><span><i style="background:var(--c3)"></i>median</span><span><i style="background:var(--c4)"></i>worst</span></div></div>
<div class="card"><h2>Components of the best (weighted)</h2><canvas id="comp" height="260"></canvas><div class="legend" id="compleg"></div></div>
<div class="card"><h2>Step size sigma and loudness gap</h2><canvas id="sig" height="260"></canvas>
<div class="legend"><span><i style="background:var(--c5)"></i>sigma</span><span><i style="background:var(--c2)"></i>level gap (dB, render minus recording; part of the score)</span></div></div>
<div class="card"><h2>Per phrase: default voice, voice carried in, evolved; held-out phrases: carried and default</h2><canvas id="time" height="260"></canvas>
<div class="legend"><span><i style="background:var(--c4)"></i>default voice</span><span><i style="background:var(--c2)"></i>carried in, before evolving</span><span><i style="background:var(--c1)"></i>evolved on this phrase</span><span><i style="background:var(--c3)"></i>held-out phrases, carried voice</span><span><i style="background:var(--c5)"></i>held-out, default voice</span></div></div>
</div>
<div class="card" style="margin-top:14px"><h2>Voice genes of the best, over the generations (0 = low end of the range, 1 = high end)</h2><canvas id="genes" height="380"></canvas></div>
<div class="card" style="margin-top:14px"><h2>Recording (top), best render (middle), difference (bottom): log-mel, time to the right</h2><canvas id="spec" height="520"></canvas></div>
<div class="card" style="margin-top:14px"><h2>Best parameters</h2><table id="tab"></table></div>
<script>
const D=__DATA__;
const css=n=>getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const L=D.log;
document.getElementById('sub').textContent=D.title+' - '+L.length+' generations, '+D.segments.length+' phrase(s), best loss '+D.best.toFixed(4)+(D.done?' (finished)':' (running, page refreshes)');
function setup(id){const c=document.getElementById(id);const r=window.devicePixelRatio||1;const w=c.clientWidth,h=+c.getAttribute('height');c.width=w*r;c.height=h*r;c.style.height=h+'px';const g=c.getContext('2d');g.scale(r,r);return{g,w,h}}
function axes(g,w,h,x0,x1,y0,y1,logy){
 const m={l:46,r:8,t:8,b:22};g.font='11px system-ui';g.fillStyle=css('--mute');g.strokeStyle=css('--grid');g.lineWidth=1;
 const fy=v=>logy?Math.log(v):v;const a=fy(y0),b=fy(y1);
 const px=x=>m.l+(x-x0)/(x1-x0||1)*(w-m.l-m.r), py=y=>h-m.b-(fy(y)-a)/(b-a||1)*(h-m.t-m.b);
 for(let i=0;i<=4;i++){const yy=logy?Math.exp(a+(b-a)*i/4):y0+(y1-y0)*i/4;const Y=py(yy);g.beginPath();g.moveTo(m.l,Y);g.lineTo(w-m.r,Y);g.stroke();g.fillText(yy.toFixed(yy<10?2:0),2,Y+4)}
 for(let i=0;i<=4;i++){const xx=x0+(x1-x0)*i/4;g.fillText(xx.toFixed(xx<10&&x1<10?1:0),px(xx)-8,h-6)}
 return{px,py}}
function line(g,pts,col,px,py){g.strokeStyle=col;g.lineWidth=1.8;g.beginPath();pts.forEach((p,i)=>{i?g.lineTo(px(p[0]),py(p[1])):g.moveTo(px(p[0]),py(p[1]))});g.stroke()}
function range(vals){let lo=Math.min(...vals),hi=Math.max(...vals);if(lo===hi){lo-=1;hi+=1}return[lo,hi]}
if(L.length){
 {const{g,w,h}=setup('loss');const all=L.flatMap(l=>[l.best,l.gen_best,l.median,l.worst]).filter(v=>v>0&&v<500);const[lo,hi]=range(all);
  const ax=axes(g,w,h,L[0].gen,L[L.length-1].gen,Math.max(lo*0.95,1e-3),hi*1.05,true);
  L.forEach((l,i)=>{if(i&&l.seg!==L[i-1].seg){g.strokeStyle=css('--mute');g.setLineDash([3,3]);g.beginPath();g.moveTo(ax.px(l.gen),8);g.lineTo(ax.px(l.gen),h-22);g.stroke();g.setLineDash([])}});
  [['worst','--c4'],['median','--c3'],['gen_best','--c2'],['best','--c1']].forEach(([k,c])=>{let seg=null,pts=[];const flush=()=>{if(pts.length)line(g,pts,css(c),ax.px,ax.py);pts=[]};L.forEach(l=>{if(l.seg!==seg){flush();seg=l.seg}pts.push([l.gen,Math.min(Math.max(l[k],1e-3),500)])});flush()})}
 {const{g,w,h}=setup('comp');const cols=['--c1','--c2','--c3','--c4','--c5'];const wts=[1,1,.5,.5,1];
  const ser=D.comp_names.map((n,i)=>L.map(l=>[l.gen,l.comps[i]*wts[i]]));const[lo,hi]=range(ser.flat().map(p=>p[1]));
  const ax=axes(g,w,h,L[0].gen,L[L.length-1].gen,Math.max(0,lo*0.9),hi*1.05,false);
  ser.forEach((s,i)=>line(g,s,css(cols[i]),ax.px,ax.py));
  document.getElementById('compleg').innerHTML=D.comp_names.map((n,i)=>'<span><i style="background:var('+cols[i]+')"></i>'+n+' '+(L[L.length-1].comps[i]).toFixed(3)+'</span>').join('')}
 {const{g,w,h}=setup('sig');const[lo,hi]=range(L.map(l=>l.sigma));const ax=axes(g,w,h,L[0].gen,L[L.length-1].gen,0,hi*1.1,false);line(g,L.map(l=>[l.gen,l.sigma]),css('--c5'),ax.px,ax.py);
  const[glo,ghi]=range(L.map(l=>l.gap));const gy=v=>h-22-(v-glo)/((ghi-glo)||1)*(h-30);g.strokeStyle=css('--c2');g.lineWidth=1.6;g.beginPath();L.forEach((l,i)=>{const X=ax.px(l.gen),Y=gy(l.gap);i?g.lineTo(X,Y):g.moveTo(X,Y)});g.stroke();g.fillStyle=css('--c2');g.fillText(glo.toFixed(1)+'..'+ghi.toFixed(1)+' dB',w-120,16)}
 {const{g,w,h}=setup('time');const S=D.segments;const keys=[['default_loss','--c4'],['start_loss','--c2'],['final_loss','--c1'],['held_loss','--c3'],['held_default','--c5']];const vals=S.flatMap(s=>keys.map(k=>s[k[0]])).filter(v=>v>0);const[lo,hi]=range(vals);const ax=axes(g,w,h,0,Math.max(1,S.length-1),Math.max(lo*0.95,1e-3),hi*1.05,true);keys.forEach(([k,c])=>{const pts=S.map((s,i)=>[i,s[k]]).filter(p=>p[1]>0);line(g,pts,css(c),ax.px,ax.py);g.fillStyle=css(c);pts.forEach(p=>{g.beginPath();g.arc(ax.px(p[0]),ax.py(p[1]),2.5,0,7);g.fill()})});g.fillStyle=css('--mute');g.fillText('phrase number (rotation)',w/2-50,h-6)}
 {const{g,w,h}=setup('genes');const n=D.names.length,G=L.length;const cw=Math.max(1,(w-170)/G),rh=(h-6)/n;
  L.forEach((l,j)=>{l.x.forEach((v,i)=>{const t=Math.max(0,Math.min(1,v));g.fillStyle='hsl('+(240-240*t)+',70%,'+(35+25*Math.abs(t-.5))+'%)';g.fillRect(170+j*cw,3+i*rh,Math.ceil(cw),Math.ceil(rh)-0.5)})});
  g.fillStyle=css('--mute');g.font=Math.min(10,Math.max(6,rh))+'px system-ui';D.names.forEach((nm,i)=>g.fillText(nm,2,3+i*rh+rh*0.8))}
}
if(D.sim.length){
 const{g,w,h}=setup('spec');const B=D.bands,F=D.sim.length/B;const pw=w-4,ph=(h-20)/3;
 const col=t=>{const r=Math.floor(255*Math.min(1,Math.max(0,1.5*t-.2))),gg=Math.floor(255*Math.min(1,Math.max(0,t*t*1.2))),b=Math.floor(255*Math.min(1,Math.max(0,.9-1.2*t+.8*t*t)));return[r,gg,b]};
 function paint(arr,y0,diff){const off=document.createElement('canvas');off.width=Math.ceil(pw);off.height=Math.ceil(ph);const og=off.getContext('2d');const im=og.createImageData(off.width,off.height);for(let y=0;y<im.height;y++)for(let x=0;x<im.width;x++){const f=Math.min(F-1,Math.floor(x/pw*F)),b=Math.min(B-1,Math.floor((1-y/ph)*B));let c;if(diff){const d=(D.sim[f*B+b]-D.ref[f*B+b])/255;c=d>0?[255*Math.min(1,d*3),60,60]:[60,60,255*Math.min(1,-d*3)]}else c=col(arr[f*B+b]/255);const o=(y*im.width+x)*4;im.data[o]=c[0];im.data[o+1]=c[1];im.data[o+2]=c[2];im.data[o+3]=255}og.putImageData(im,0,0);g.drawImage(off,2,y0,pw,ph)}
 paint(D.ref,0,false);paint(D.sim,ph+10,false);paint(null,2*ph+20,true)
}
{const t=document.getElementById('tab');const last=L.length?L[L.length-1].x:[];
 t.innerHTML='<tr><th>gene</th><th>position in range</th></tr>'+D.names.map((n,i)=>'<tr><td>'+n+'</td><td>'+(last[i]===undefined?'':last[i].toFixed(3))+'</td></tr>').join('')}
</script></body></html>
"##;
