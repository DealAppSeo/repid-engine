//! Emit a real batch-aggregate proof to `aggregate-proof.bin` for on-chain anchoring (P5).
//! Run: cargo run --release --example emit_aggregate_proof

use std::fs;
use zkp_vault::aggregate::{batch_digest, group_of, prove_aggregate, N_OWNERS};
use zkp_vault::proof_to_bytes;

fn main() {
    let owners: [(u64, u64, u64); N_OWNERS] = [
        (10, 100, 901),
        (20, 200, 902),
        (30, 300, 903),
        (40, 400, 904),
        (10, 100, 905),
        (20, 200, 906),
        (30, 300, 907),
        (40, 400, 908),
    ];
    let group = group_of(&[(10, 100), (20, 200), (30, 300), (40, 400)]);
    let proof = prove_aggregate(&owners, &group);
    let bytes = proof_to_bytes(&proof);
    fs::write("aggregate-proof.bin", &bytes).expect("write");
    let digest = batch_digest(&owners);
    println!(
        "wrote aggregate-proof.bin {} bytes; owners={} batch_digest={:?}",
        bytes.len(),
        N_OWNERS,
        digest
    );
}
