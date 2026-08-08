// gen-synthetic-rangecheck-proof.rs — how tests/fixtures/zkp/leaf-rangecheck.synthetic.plonky3.bin
// was generated. SYNTHETIC ONLY. This file is documentation + a reproducible recipe; it is NOT
// compiled by this repo's build (repid-engine has no Rust workspace member at this path, and the
// range-check circuit lives at a different Plonky3 pin than zkp-vault — see docs/zkp/
// PLONKY3_PIN_RECONCILIATION.md).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS
// ─────────────────────────────────────────────────────────────────────────────────────────────
// The cross-crate test tests/zkp-proof-verifier-crosscheck.test.ts runs a Plonky3 range-check
// proof through the REAL @hyperdag/proof-verifier WASM. That proof must be SYNTHETIC — PR #376
// committed a real proof lifted from the production repid_zkp_proofs table (a real agent UUID,
// a real score), which in a PUBLIC repo is a permanent production extract. The permanent #376
// fence (scripts/hooks/prod-fixture-guard.js) now blocks that shape.
//
// A range-check proof can only be produced by the range-check circuit — zkp-vault proves a
// DIFFERENT statement (anonymous membership/nullifier), so it cannot mint one. The circuit that
// CAN is the @hyperdag/proof-verifier crate's own prover, exercised here against fabricated
// inputs. The result is a genuine STARK proof over a witness that never existed in production.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// HOW IT WAS RUN (offline, no DB, no network beyond the crates the verifier already pins)
// ─────────────────────────────────────────────────────────────────────────────────────────────
//   1. git clone https://github.com/DealAppSeo/hyperdag-proof-verifier  (the verify package's
//      Rust source — it embeds a range-check prover in its #[cfg(test)] module).
//   2. Append the generator test below to its src/lib.rs `tests` module (it reuses that module's
//      make_config / gen_trace / build_public_values / RepIdRangeCheckAir helpers verbatim, so the
//      proof is byte-for-byte the shape verify_proof expects).
//   3. EMIT_DIR=<out> cargo test emit_synthetic_fixture -- --nocapture
//   4. Copy <out>/leaf-rangecheck.synthetic.plonky3.bin into tests/fixtures/zkp/.
//
// The inputs are the ONLY thing that matters for honesty, and they are all fabricated:
//   agent_id  = 00000000-0000-4000-8000-0000000000aa   (a NIL-variant UUID, never a real agent)
//   threshold = 999
//   repid     = 2280                                    (a made-up score above the threshold)
//
// The generator self-verifies the proof through the crate's own verify_proof before emitting, so
// a committed fixture that does not verify can never be produced.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE GENERATOR (append to hyperdag-proof-verifier/src/lib.rs `mod tests`)
// ─────────────────────────────────────────────────────────────────────────────────────────────
/*
#[test]
fn emit_synthetic_fixture() {
    let dir = match std::env::var("EMIT_DIR") {
        Ok(d) => d,
        Err(_) => return, // no-op in an ordinary test run
    };
    // Purely synthetic identity + claim. NIL-ish UUID variant, never a real agent.
    const SYNTH_AGENT: &str = "00000000-0000-4000-8000-0000000000aa";
    let (threshold, repid) = (999u64, 2280u64);

    let gap = (repid - threshold - 1) as u32;
    let config = make_config();
    let air = RepIdRangeCheckAir { value: gap };
    let trace = gen_trace(gap);
    let pv = build_public_values(SYNTH_AGENT, threshold, repid).unwrap();
    let proof = prove(&config, &air, trace, &pv);
    let bytes = bincode::serialize(&proof).unwrap();

    // Self-check: this crate verifies the proof we just made before we emit it.
    let r = run_verify(
        &base64::engine::general_purpose::STANDARD.encode(&bytes),
        SYNTH_AGENT, threshold, repid,
    );
    assert!(r.verified, "generated synthetic proof must self-verify: {:?}", r.error);

    std::fs::write(format!("{dir}/leaf-rangecheck.synthetic.plonky3.bin"), &bytes).unwrap();
    eprintln!("EMITTED synthetic proof: {} bytes -> {dir}", bytes.len());
}
*/
