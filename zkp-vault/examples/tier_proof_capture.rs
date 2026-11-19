//! Capture one threshold-tier proof (Shadow FRI) and print its public inputs and the verifier's result.
//!
//! ```text
//! cargo run --release --locked --example tier_proof_capture -- <out.bin>
//! ```
//! Deterministic fixture (the tier tests' snapshot), a fresh challenge, so the proof bytes differ per run:
//! the hiding PCS draws its masks from the OS. The verdict is NotChecked: nothing anchors the root.
use std::time::Duration;

use p3_field::{PrimeCharacteristicRing, PrimeField32};
use zkp_vault::eligibility::{identity_commitment, leaf, proof_to_bytes, Digest, Fri, Scope, Snapshot, VerifierState, Witness};
use zkp_vault::tier::{prove_threshold_tier, tier_policy, Tier};
use p3_baby_bear::BabyBear as Val;

const EPOCH: u32 = 20409;
const SCORES: [u32; 8] = [120, 980, 499, 10_000, 30, 742, 500, 15];
const ME: usize = 5;
const ISSUER: &str = "repid-engine/attester/v0";

fn sk_of(i: usize) -> Digest {
    core::array::from_fn(|k| Val::from_u32(1000 * (i as u32 + 1) + k as u32 + 1))
}
fn salt_of(i: usize) -> [Val; 5] {
    core::array::from_fn(|k| Val::from_u32(77_000 + 10 * i as u32 + k as u32))
}
fn hex8(d: &Digest) -> Vec<u32> {
    d.iter().map(|x| x.as_canonical_u32()).collect()
}

fn main() {
    let out = std::env::args().nth(1).expect("usage: tier_proof_capture <out.bin>");
    let leaves: Vec<Digest> =
        (0..SCORES.len()).map(|i| leaf(&identity_commitment(&sk_of(i)), SCORES[i], EPOCH, &salt_of(i))).collect();
    let snap = Snapshot::new(EPOCH, &leaves);
    let scope = Scope { domain: "repid".into(), verifier_id: "trustshell/tier-display".into(), scope_epoch: "2026-11-18".into() };
    let mut v = VerifierState::new(scope.clone(), Fri::Shadow, Duration::from_secs(300));
    let c = v.issue_challenge();
    let w = Witness { sk: sk_of(ME), score: SCORES[ME], salt: salt_of(ME), path: snap.path(ME) };
    let p = prove_threshold_tier(Fri::Shadow, &w, Tier::Earning, &scope, ISSUER, 1, EPOCH, &snap.root(), &c).expect("proves");
    let bytes = proof_to_bytes(&p.proof);
    std::fs::write(&out, &bytes).expect("write proof");
    let policy = tier_policy(Tier::Earning, "repid", ISSUER, 1);
    let check = v.present_tier(ISSUER, 1, &c, EPOCH, &snap.root(), false, &p);
    println!(
        "{}",
        serde_json::json!({
            "fri": "Shadow",
            "proof_bytes": bytes.len(),
            "public_inputs": {
                "threshold": policy.threshold,
                "epoch": EPOCH,
                "root": hex8(&snap.root()),
                "pc_null": hex8(&scope.pc_null()),
                "nullifier": hex8(&p.nullifier),
                "policy_hash": hex8(&policy.hash()),
                "challenge": hex8(&c),
            },
            "derived_tier": format!("{:?}", check.tier),
            "verdict": format!("{:?}", check.verdict),
            "displayable": format!("{:?}", check.displayable()),
        })
    );
}
