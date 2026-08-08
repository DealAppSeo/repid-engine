//! `leaf_proof_measure` — REAL, runnable measurement of the leaf STARK at the pin.
//!
//! Deliverable (1) of the "Plonky3 REAL PATH" task: generate a **synthetic** leaf
//! proof at the canonical pin (`p3-* 0.3.0`, Poseidon2-BabyBear width-16) and measure
//!   - prove time
//!   - verify time
//!   - proof size (bytes, `bincode`-serialized)
//! across a warmup + N timed iterations, reporting min / median / mean and one
//! machine-readable JSON line.
//!
//! Everything here is SYNTHETIC and self-generated in-process (fixed demo constants
//! `secret=777, agent_id=555, context=9001`). No production row, no real agent id, no
//! live proof, no DB, no network. Run:
//!
//! ```text
//! cargo run --release --example leaf_proof_measure -- 25
//! ```
//!
//! The single sample already emitted by the crate's `bench_prove_verify` test is one
//! draw; this harness is the statistically-honest version (warmup to exclude first-run
//! allocator/JIT-of-nothing effects, median to resist outliers) and it prints the
//! ruler alongside the number, per CLAUDE_RULES r24 ("a measurement without its ruler
//! is not a result").

use std::time::Instant;

use zkp_vault::{
    commitment, nullifier, proof_to_bytes, prove_ownership, verify_ownership, GROUP_SIZE,
};

/// The pin/ruler this number is taken at. Printed with every result so the number is
/// never quoted bare. Mirrors the constants compiled into the crate.
const PIN: &str = "p3-* 0.3.0";
const HASH: &str = "poseidon2-babybear16 (width=16, sbox=x^7, RF=8, RP=13)";
const STATEMENT: &str = "Semaphore-style membership + scoped nullifier (no reputation in-circuit)";

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    let idx = ((sorted.len() as f64 - 1.0) * p).round() as usize;
    sorted[idx]
}

fn mean(xs: &[f64]) -> f64 {
    xs.iter().sum::<f64>() / xs.len() as f64
}

fn summary(label: &str, mut xs: Vec<f64>) -> (f64, f64, f64, f64) {
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mn = xs[0];
    let md = percentile(&xs, 0.5);
    let mx = *xs.last().unwrap();
    let mu = mean(&xs);
    eprintln!(
        "  {label:<7} min={mn:7.2}ms  median={md:7.2}ms  mean={mu:7.2}ms  max={mx:7.2}ms"
    );
    (mn, md, mu, mx)
}

fn main() {
    // Iterations from argv (default 25). Synthetic, fixed statement.
    let n: usize = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(25);

    // ---- SYNTHETIC statement -------------------------------------------------
    // A registered group whose member #1 is the (fake) owner. These are literal demo
    // constants, generated here — never a production identity.
    let (secret, agent_id, context) = (777u64, 555u64, 9001u64);
    let group = [
        commitment(11, 101),
        commitment(secret, agent_id), // the real member; index stays hidden in-proof
        commitment(33, 303),
        commitment(44, 404),
    ];
    let n_pub = nullifier(secret, context);

    eprintln!("== zkp-vault leaf-proof measurement ==");
    eprintln!("  pin        : {PIN}");
    eprintln!("  hash       : {HASH}");
    eprintln!("  statement  : {STATEMENT}");
    eprintln!("  group_size : {GROUP_SIZE}");
    eprintln!("  iterations : {n} (after 3 warmup)");
    eprintln!("  inputs     : SYNTHETIC (secret=777, agent_id=555, context=9001)");

    // ---- Warmup (excluded) ---------------------------------------------------
    for _ in 0..3 {
        let p = prove_ownership(secret, agent_id, context, &group);
        verify_ownership(&p, context, n_pub, &group).expect("warmup verify");
    }

    // ---- Timed loop ----------------------------------------------------------
    let mut prove_ms = Vec::with_capacity(n);
    let mut verify_ms = Vec::with_capacity(n);
    let mut proof_bytes = 0usize;

    for _ in 0..n {
        let t0 = Instant::now();
        let proof = prove_ownership(secret, agent_id, context, &group);
        prove_ms.push(t0.elapsed().as_secs_f64() * 1e3);

        let bytes = proof_to_bytes(&proof);
        proof_bytes = bytes.len(); // deterministic; last write wins

        let t1 = Instant::now();
        verify_ownership(&proof, context, n_pub, &group).expect("verify must pass");
        verify_ms.push(t1.elapsed().as_secs_f64() * 1e3);
    }

    eprintln!("-- results --");
    let (p_min, p_med, p_mean, p_max) = summary("prove", prove_ms.clone());
    let (v_min, v_med, v_mean, v_max) = summary("verify", verify_ms.clone());
    eprintln!("  proof   size={proof_bytes} bytes (constant — fixed statement/params)");

    // One machine-readable line for downstream capture. Prefix makes it grep-able.
    println!(
        "MEASUREMENT_JSON {{\"pin\":\"{PIN}\",\"hash\":\"{HASH}\",\"group_size\":{GROUP_SIZE},\
\"iterations\":{n},\"proof_bytes\":{proof_bytes},\
\"prove_ms\":{{\"min\":{p_min:.3},\"median\":{p_med:.3},\"mean\":{p_mean:.3},\"max\":{p_max:.3}}},\
\"verify_ms\":{{\"min\":{v_min:.3},\"median\":{v_med:.3},\"mean\":{v_mean:.3},\"max\":{v_max:.3}}},\
\"synthetic\":true,\"real_stark\":true}}"
    );
}
