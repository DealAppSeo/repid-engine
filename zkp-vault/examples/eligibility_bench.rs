//! The ZK row of the eligibility utility bench (spec §12). The two baselines are
//! `scripts/zkp/eligibility-bench.ts`; the report sets the three side by side.
//!
//!   cargo run --release --example eligibility_bench [iterations]
//!
//! Prints one JSON object: median prove and verify time, proof bytes and peak heap, for the Shadow FRI
//! profile (the only one a claim may use) and the Test profile (gates only), with the ruler.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
use std::time::Instant;

use p3_field::PrimeCharacteristicRing;
use zkp_vault::eligibility::*;

// ---- peak heap: a counting allocator ----------------------------------------------------------------
struct Counting;
static CUR: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(l) };
        if !p.is_null() {
            let now = CUR.fetch_add(l.size(), Relaxed) + l.size();
            PEAK.fetch_max(now, Relaxed);
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        unsafe { System.dealloc(p, l) };
        CUR.fetch_sub(l.size(), Relaxed);
    }
}
#[global_allocator]
static A: Counting = Counting;

fn peak_during<T>(f: impl FnOnce() -> T) -> (T, usize) {
    let base = CUR.load(Relaxed);
    PEAK.store(base, Relaxed);
    let t = f();
    (t, PEAK.load(Relaxed) - base)
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn main() {
    let n: usize = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(20);
    let epoch = 20409;
    let sk_of = |i: u32| -> Digest { core::array::from_fn(|k| p3_baby_bear::BabyBear::from_u32(1000 * (i + 1) + k as u32 + 1)) };
    let salt_of = |i: u32| -> [p3_baby_bear::BabyBear; 5] { core::array::from_fn(|k| p3_baby_bear::BabyBear::from_u32(77_000 + 10 * i + k as u32)) };
    let scores = [120u32, 980, 499, 10_000, 30, 742, 500, 15];
    let leaves: Vec<Digest> = (0..8).map(|i| leaf(&identity_commitment(&sk_of(i)), scores[i as usize], epoch, &salt_of(i))).collect();
    let snap = Snapshot::new(epoch, &leaves);
    let me = 5usize;
    let w = Witness { sk: sk_of(me as u32), score: scores[me], salt: salt_of(me as u32), path: snap.path(me) };

    let mut rows = Vec::new();
    for fri in [Fri::Shadow, Fri::Test] {
        let (mut prove_ms, mut verify_ms, mut bytes, mut prove_heap, mut verify_heap) = (vec![], vec![], 0, 0, 0);
        for _ in 0..n {
            // BEGIN verify-zk (what a verifier writes; counted for the integration column)
            let policy = Policy::score_gte(500, "repid", "repid-engine/attester/v0", 1);
            let scope = Scope { domain: "repid".into(), verifier_id: "trustmarket/sandbox-1".into(), scope_epoch: "2026-11-17".into() };
            let mut verifier = VerifierState::default();
            let challenge = verifier.issue_challenge();
            // END verify-zk
            let st = Statement { threshold: 500, epoch, root: snap.root(), pc_null: scope.pc_null(), nullifier: nullifier(&w.sk, &scope),
                                 policy_hash: policy.hash(), challenge };
            let t0 = Instant::now();
            let (proof, ph) = peak_during(|| prove_eligibility(fri, &w, &st).unwrap());
            prove_ms.push(t0.elapsed().as_secs_f64() * 1e3);
            prove_heap = prove_heap.max(ph);
            bytes = proof_to_bytes(&proof).len();
            let t1 = Instant::now();
            let (verdict, vh) = peak_during(|| {
                verifier.present(fri, &policy, &scope, &challenge, epoch, epoch, &snap.root(), false, &st.nullifier, &proof)
            });
            verify_ms.push(t1.elapsed().as_secs_f64() * 1e3);
            verify_heap = verify_heap.max(vh);
            assert!(matches!(verdict, Verdict::Eligible { .. }), "honest presentation rejected");
        }
        rows.push(serde_json::json!({
            "approach": "c) ZK predicate (this circuit)",
            "fri_profile": format!("{fri:?}"),
            "conjectured_soundness_bits": fri.conjectured_bits(),
            "verifier_learns": ["snapshot root + epoch", "threshold T", "scoped nullifier (links presentations to one verifier scope only)", "policy hash", "its own challenge"],
            "prove_ms_median": median(prove_ms),
            "verify_ms_median": median(verify_ms),
            "proof_bytes": bytes,
            "prove_peak_heap_kb": prove_heap / 1024,
            "verify_peak_heap_kb": verify_heap / 1024,
        }));
    }
    let src = include_str!("eligibility_bench.rs");
    let block = src.split("// BEGIN verify-zk").nth(1).and_then(|s| s.split("// END verify-zk").next()).unwrap_or("");
    let lines = block.lines().filter(|l| { let t = l.trim(); !t.is_empty() && !t.starts_with("//") }).count() + 1; // + the present() call
    let commit = std::process::Command::new("git").args(["rev-parse", "HEAD"]).output().ok()
        .and_then(|o| String::from_utf8(o.stdout).ok()).map(|s| s.trim().to_string()).unwrap_or_default();
    println!("{}", serde_json::to_string_pretty(&serde_json::json!({
        "ruler": {
            "commit": commit, "os": std::env::consts::OS, "arch": std::env::consts::ARCH,
            "threads": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0),
            "iterations": n, "plonky3": "git 27d59f73 (0.5.1)", "height": HEIGHT, "depth": DEPTH,
            "fri": "log_blowup 3, max_log_arity 1, query PoW 1, commit PoW 0; queries 33 (Shadow) / 2 (Test)",
        },
        "rows": rows,
        "verifier_integration_lines": lines,
    })).unwrap());
}
