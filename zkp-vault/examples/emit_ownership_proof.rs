//! Emit a real anonymous-ownership proof to `proof.bin` for on-chain anchoring.
//! Run: cargo run --release --example emit_ownership_proof
//! Then anchor with scripts/zkp/anchor-ownership-base-sepolia.cjs.

use std::fs;
use zkp_vault::{commitment, nullifier, proof_to_bytes, prove_ownership, GROUP_SIZE};

fn main() {
    let (secret, agent_id, context) = (777u64, 555u64, 9001u64);
    assert_eq!(GROUP_SIZE, 4);
    let group = [
        commitment(11, 101),
        commitment(secret, agent_id),
        commitment(33, 303),
        commitment(44, 404),
    ];
    let proof = prove_ownership(secret, agent_id, context, &group);
    let bytes = proof_to_bytes(&proof);
    fs::write("proof.bin", &bytes).expect("write proof.bin");
    // nullifier is the public, context-scoped double-action key.
    let n = nullifier(secret, context);
    println!("wrote proof.bin {} bytes; context={} nullifier={:?}", bytes.len(), context, n);
}
