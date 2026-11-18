//! Every constraint C1..C11 has a forgery test here that builds the trace the missing constraint would
//! allow, proves it, and requires rejection by the prover (debug) or the verifier (any profile). Each is
//! paired with a mutant in E:\dev\ops\loop\zk-ruler-loop.mjs that deletes the constraint: KILLED means the
//! test noticed. A forgery that is rejected for some OTHER reason would make its test vacuous; the mutant
//! run is what shows it is not.

use super::*;

const EPOCH: u32 = 20409;
const T: u64 = 500;
const ME: usize = 5;
const SCORES: [u32; 8] = [120, 980, 499, 10_000, 30, 742, 500, 15];
const Z8: Digest = [Val::ZERO; 8];

fn sk_of(i: u32) -> Digest {
    core::array::from_fn(|k| Val::from_u32(1000 * (i + 1) + k as u32 + 1))
}
fn salt_of(i: u32) -> [Val; 5] {
    core::array::from_fn(|k| Val::from_u32(77_000 + 10 * i + k as u32))
}
fn d8(x: u32) -> Digest {
    [Val::from_u32(x); 8]
}
fn out(row: &[Val; 16]) -> Digest {
    out8(&perm(*row))
}
fn leaf_of(i: usize) -> Digest {
    leaf(&identity_commitment(&sk_of(i as u32)), SCORES[i], EPOCH, &salt_of(i as u32))
}
fn leaves() -> Vec<Digest> {
    (0..SCORES.len()).map(leaf_of).collect()
}
fn bits_of(gap: u64) -> [Val; GAP_BITS] {
    core::array::from_fn(|k| Val::from_bool((gap >> k) & 1 == 1))
}

struct Fx {
    snap: Snapshot,
    policy: Policy,
    scope: Scope,
}

fn fx() -> Fx {
    Fx {
        snap: Snapshot::new(EPOCH, &leaves()),
        policy: Policy::score_gte(T, "repid", "repid-engine/attester/v0", 1),
        scope: Scope { domain: "repid".into(), verifier_id: "trustmarket/sandbox-1".into(), scope_epoch: "2026-11-17".into() },
    }
}

fn statement(snap: &Snapshot, policy: &Policy, scope: &Scope, sk: &Digest, challenge: Digest) -> Statement {
    Statement {
        threshold: policy.threshold,
        epoch: snap.epoch,
        root: snap.root(),
        pc_null: scope.pc_null(),
        nullifier: nullifier(sk, scope),
        policy_hash: policy.hash(),
        challenge,
    }
}

fn witness(snap: &Snapshot, i: usize) -> Witness {
    Witness { sk: sk_of(i as u32), score: SCORES[i], salt: salt_of(i as u32), path: snap.path(i) }
}

/// A trace from explicit parts, so a forgery can choose each row.
fn spec_from(row0: [Val; 16], row1: [Val; 16], head: Digest, tail: Digest, path: &[(Digest, bool)], bits: [Val; GAP_BITS]) -> TraceSpec {
    let mut inputs = vec![[Val::ZERO; 16]; HEIGHT];
    let mut dir = vec![Val::ZERO; HEIGHT];
    inputs[0] = row0;
    inputs[1] = row1;
    inputs[2] = absorb_secret(&head, &tail);
    let mut cur = out(&inputs[2]);
    for (k, (sib, d)) in path.iter().enumerate() {
        let r = 3 + k;
        inputs[r] = if *d { absorb_secret(sib, &cur) } else { absorb_secret(&cur, sib) };
        dir[r] = Val::from_bool(*d);
        cur = out(&inputs[r]);
    }
    TraceSpec { inputs, dir, bits }
}

fn rejected(spec: &TraceSpec, st: &Statement) -> bool {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {})); // the debug-profile constraint panic is expected
    let built = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| prove_spec(Fri::Test, spec, st)));
    std::panic::set_hook(prev);
    match built {
        // Only Plonky3's own constraint check counts as a rejection. Any other panic (a bug in the forgery,
        // an index out of range) is re-raised: swallowing it would read an unrelated failure as "rejected".
        // Same flaw Codex found in HyperDAG-core #23's helper (fixed there in 8096df28).
        Err(payload) => {
            let msg = payload.downcast_ref::<String>().map(String::as_str)
                .or_else(|| payload.downcast_ref::<&str>().copied()).unwrap_or("");
            if !msg.contains("constraints not satisfied") {
                std::panic::resume_unwind(payload);
            }
            true
        }
        Ok(p) => !verify_stark(Fri::Test, &p, st),
    }
}

fn assert_forgery_rejected(label: &str, spec: &TraceSpec, st: &Statement) {
    assert!(rejected(spec, st), "SOUNDNESS BREAK [{label}]: a forged trace was proven AND verified");
}

// ---- honest behaviour ----------------------------------------------------------------------------------

#[test]
fn honest_proof_verifies() {
    let f = fx();
    let w = witness(&f.snap, ME);
    let st = statement(&f.snap, &f.policy, &f.scope, &w.sk, d8(9));
    let p = prove_eligibility(Fri::Test, &w, &st).expect("742 >= 500");
    assert_eq!(p.degree_bits, EXPECTED_DEGREE_BITS);
    assert!(verify_stark(Fri::Test, &p, &st));
}

#[test]
fn score_equal_to_threshold_verifies() {
    let f = fx();
    let w = witness(&f.snap, 6); // score 500 == T
    let st = statement(&f.snap, &f.policy, &f.scope, &w.sk, d8(9));
    let p = prove_eligibility(Fri::Test, &w, &st).expect("500 >= 500");
    assert!(verify_stark(Fri::Test, &p, &st));
}

#[test]
fn below_threshold_is_refused_by_the_honest_prover() {
    let f = fx();
    let w = witness(&f.snap, 2); // score 499
    let st = statement(&f.snap, &f.policy, &f.scope, &w.sk, d8(9));
    assert_eq!(prove_eligibility(Fri::Test, &w, &st).err(), Some(ProveError::BelowThreshold));
}

#[test]
fn shadow_profile_proof_verifies() {
    let f = fx();
    let w = witness(&f.snap, ME);
    let st = statement(&f.snap, &f.policy, &f.scope, &w.sk, d8(9));
    let p = prove_eligibility(Fri::Shadow, &w, &st).unwrap();
    assert!(verify_stark(Fri::Shadow, &p, &st));
    assert!(!verify_stark(Fri::Test, &p, &st), "a proof must not verify under other FRI parameters");
}

// ---- one forgery per constraint ------------------------------------------------------------------------

/// The honest parts for agent `i`, so each forgery changes exactly one thing.
fn honest_parts(f: &Fx, i: usize) -> ([Val; 16], [Val; 16], Digest, Digest, Vec<(Digest, bool)>, [Val; GAP_BITS]) {
    let sk = sk_of(i as u32);
    let idc = identity_commitment(&sk);
    (
        absorb_secret(&sk, &f.scope.pc_null()),
        absorb_secret(&sk, &pc_commit()),
        idc,
        leaf_tail(SCORES[i], EPOCH, &salt_of(i as u32)),
        f.snap.path(i),
        bits_of(SCORES[i] as u64 - T),
    )
}

#[test]
fn c1_nullifier_row_must_absorb_the_verifiers_scope() {
    let f = fx();
    let (mut r0, r1, h, t, p, b) = honest_parts(&f, ME);
    r0[8..].copy_from_slice(&d8(424242)); // a capacity of the prover's choosing: a fresh nullifier every time
    let mut st = statement(&f.snap, &f.policy, &f.scope, &sk_of(ME as u32), d8(9));
    st.nullifier = out(&r0);
    assert_forgery_rejected("C1 nullifier from a prover-chosen scope", &spec_from(r0, r1, h, t, &p, b), &st);
}

#[test]
fn c2_published_nullifier_must_be_the_rows_output() {
    let f = fx();
    let (r0, r1, h, t, p, b) = honest_parts(&f, ME);
    let mut st = statement(&f.snap, &f.policy, &f.scope, &sk_of(ME as u32), d8(9));
    st.nullifier = d8(12345);
    assert_forgery_rejected("C2 arbitrary nullifier", &spec_from(r0, r1, h, t, &p, b), &st);
}

#[test]
fn c3_nullifier_and_commitment_use_the_same_secret() {
    let f = fx();
    let (_, r1, h, t, p, b) = honest_parts(&f, ME);
    let throwaway = sk_of(99);
    let r0 = absorb_secret(&throwaway, &f.scope.pc_null());
    let mut st = statement(&f.snap, &f.policy, &f.scope, &sk_of(ME as u32), d8(9));
    st.nullifier = nullifier(&throwaway, &f.scope);
    assert_forgery_rejected("C3 nullifier from a throwaway secret", &spec_from(r0, r1, h, t, &p, b), &st);
}

#[test]
fn c4_commitment_row_absorbs_the_fixed_prefix() {
    // The snapshot holds a commitment made with the WRONG prefix (zeros). Removing C4 frees the commitment
    // function; with Poseidon2 invertible, that is full impersonation (spec §4). Here the simplest form.
    let f = fx();
    let sk = sk_of(ME as u32);
    let r1 = absorb_secret(&sk, &Z8);
    let idc_alt = out(&r1);
    let t = leaf_tail(SCORES[ME], EPOCH, &salt_of(ME as u32));
    let mut lv = leaves();
    lv[ME] = compress(&idc_alt, &t);
    let alt = Snapshot::new(EPOCH, &lv);
    let st = statement(&alt, &f.policy, &f.scope, &sk, d8(9));
    let spec = spec_from(absorb_secret(&sk, &f.scope.pc_null()), r1, idc_alt, t, &alt.path(ME), bits_of(SCORES[ME] as u64 - T));
    assert_forgery_rejected("C4 commitment with a free prefix", &spec, &st);
}

#[test]
fn c5_leaf_must_name_the_provers_own_commitment() {
    // The attacker knows the victim's leaf opening and path (worst case) but not the victim's secret.
    let f = fx();
    let attacker = sk_of(99);
    let (_, _, victim_idc, t, p, b) = honest_parts(&f, ME);
    let mut st = statement(&f.snap, &f.policy, &f.scope, &attacker, d8(9));
    st.nullifier = nullifier(&attacker, &f.scope);
    let spec = spec_from(absorb_secret(&attacker, &f.scope.pc_null()), absorb_secret(&attacker, &pc_commit()), victim_idc, t, &p, b);
    assert_forgery_rejected("C5 impersonation by naming the victim's commitment", &spec, &st);
}

#[test]
fn c6_leaf_epoch_is_the_statements_epoch() {
    let f = fx();
    let (r0, r1, h, t, p, b) = honest_parts(&f, ME); // the leaf really is from EPOCH
    let mut st = statement(&f.snap, &f.policy, &f.scope, &sk_of(ME as u32), d8(9));
    st.epoch = EPOCH + 1; // claim the snapshot is a later one
    assert_forgery_rejected("C6 epoch re-read", &spec_from(r0, r1, h, t, &p, b), &st);
}

#[test]
fn c6_leaf_carries_the_leaf_tag() {
    let f = fx();
    let (r0, r1, h, mut t, _, b) = honest_parts(&f, ME);
    t[2] = Val::ZERO; // a leaf in another format
    let mut lv = leaves();
    lv[ME] = compress(&h, &t);
    let alt = Snapshot::new(EPOCH, &lv);
    let st = statement(&alt, &f.policy, &f.scope, &sk_of(ME as u32), d8(9));
    assert_forgery_rejected("C6 leaf without its tag", &spec_from(r0, r1, h, t, &alt.path(ME), b), &st);
}

#[test]
fn c7_gap_bits_must_be_boolean() {
    // Agent 2 scores 499 < 500. One "bit" holds s - T (= p - 1) itself, so the sum matches exactly.
    let f = fx();
    let (r0, r1, h, t, p, _) = honest_parts_below(&f, 2);
    let mut bits = [Val::ZERO; GAP_BITS];
    bits[0] = Val::from_u32(SCORES[2]) - Val::from_u64(T);
    let st = statement(&f.snap, &f.policy, &f.scope, &sk_of(2), d8(9));
    assert_forgery_rejected("C7 non-boolean bit", &spec_from(r0, r1, h, t, &p, bits), &st);
}

#[test]
fn c8_gap_is_bound_to_score_minus_threshold() {
    let f = fx();
    let (r0, r1, h, t, p, _) = honest_parts_below(&f, 2);
    let st = statement(&f.snap, &f.policy, &f.scope, &sk_of(2), d8(9));
    assert_forgery_rejected("C8 gap not tied to s - T", &spec_from(r0, r1, h, t, &p, bits_of(5)), &st);
}

fn honest_parts_below(f: &Fx, i: usize) -> ([Val; 16], [Val; 16], Digest, Digest, Vec<(Digest, bool)>, [Val; GAP_BITS]) {
    let sk = sk_of(i as u32);
    (
        absorb_secret(&sk, &f.scope.pc_null()),
        absorb_secret(&sk, &pc_commit()),
        identity_commitment(&sk),
        leaf_tail(SCORES[i], EPOCH, &salt_of(i as u32)),
        f.snap.path(i),
        [Val::ZERO; GAP_BITS],
    )
}

#[test]
fn c9_direction_must_be_boolean() {
    // The attacker's leaf is in NO tree. With dir = 2, C10 accepts any pair [L ‖ R] with L = 2R - cur, so the
    // test builds a tree holding such a pair (L, R) at slots 0 and 1 and proves membership of a leaf it lacks.
    let f = fx();
    let attacker = sk_of(99);
    let idc = identity_commitment(&attacker);
    let t = leaf_tail(900, EPOCH, &salt_of(99));
    let cur = compress(&idc, &t);
    let r = leaf_of(0);
    let two = Val::from_u32(2);
    let l: Digest = core::array::from_fn(|j| two * r[j] - cur[j]);
    let mut lv = leaves();
    lv[0] = l;
    lv[1] = r;
    let alt = Snapshot::new(EPOCH, &lv);
    let mut st = statement(&alt, &f.policy, &f.scope, &attacker, d8(9));
    st.nullifier = nullifier(&attacker, &f.scope);
    let mut spec = spec_from(absorb_secret(&attacker, &f.scope.pc_null()), absorb_secret(&attacker, &pc_commit()), idc, t,
        &alt.path(0), bits_of(900 - T));
    // Row 3 is the crafted pair; the rows above it are the honest path from node(0,1) to the root.
    spec.inputs[3] = absorb_secret(&l, &r);
    spec.dir[3] = two;
    let mut node = out(&spec.inputs[3]);
    for (k, (sib, d)) in alt.path(0).iter().enumerate().skip(1) {
        let row = 3 + k;
        spec.inputs[row] = if *d { absorb_secret(sib, &node) } else { absorb_secret(&node, sib) };
        spec.dir[row] = Val::from_bool(*d);
        node = out(&spec.inputs[row]);
    }
    assert_eq!(node, alt.root(), "test construction: the crafted path must reach the tree's root");
    assert_forgery_rejected("C9 non-boolean direction", &spec, &st);
}

#[test]
fn c10_path_must_start_from_the_provers_leaf() {
    // The attacker's own leaf (in no tree), followed by the victim's path rows verbatim.
    let f = fx();
    let attacker = sk_of(99);
    let victim = honest_spec(&witness(&f.snap, ME), &statement(&f.snap, &f.policy, &f.scope, &sk_of(ME as u32), d8(9))).unwrap();
    let idc = identity_commitment(&attacker);
    let mut spec = spec_from(absorb_secret(&attacker, &f.scope.pc_null()), absorb_secret(&attacker, &pc_commit()), idc,
        leaf_tail(900, EPOCH, &salt_of(99)), &[], bits_of(900 - T));
    for r in 3..3 + DEPTH {
        spec.inputs[r] = victim.inputs[r];
        spec.dir[r] = victim.dir[r];
    }
    let mut st = statement(&f.snap, &f.policy, &f.scope, &attacker, d8(9));
    st.nullifier = nullifier(&attacker, &f.scope);
    assert_forgery_rejected("C10 unchained path", &spec, &st);
}

#[test]
fn c11_path_must_reach_the_statements_root() {
    let f = fx();
    let (r0, r1, h, t, p, b) = honest_parts(&f, ME);
    let mut st = statement(&f.snap, &f.policy, &f.scope, &sk_of(ME as u32), d8(9));
    st.root = d8(7);
    assert_forgery_rejected("C11 any root", &spec_from(r0, r1, h, t, &p, b), &st);
}

// ---- transcript binding (spec §4 note 2): these public values are in no constraint ------------------------

#[test]
fn proof_does_not_verify_under_another_challenge_policy_or_threshold() {
    let f = fx();
    let w = witness(&f.snap, ME);
    let st = statement(&f.snap, &f.policy, &f.scope, &w.sk, d8(9));
    let p = prove_eligibility(Fri::Test, &w, &st).unwrap();
    let other_challenge = Statement { challenge: d8(10), ..st.clone() };
    assert!(!verify_stark(Fri::Test, &p, &other_challenge), "replay under another challenge");
    let other_policy = Statement { policy_hash: Policy::score_gte(T, "repid", "someone-else", 1).hash(), ..st.clone() };
    assert!(!verify_stark(Fri::Test, &p, &other_policy), "presented under another policy");
    // Free-model idea 2026-11-17 #1, carried over: shift T. 742 >= 400 is TRUE, so only binding stops this.
    let other_threshold = Statement { threshold: 400, ..st.clone() };
    assert!(!verify_stark(Fri::Test, &p, &other_threshold), "presented under another threshold");
}

#[test]
fn tampered_proof_rejected() {
    let f = fx();
    let w = witness(&f.snap, ME);
    let st = statement(&f.snap, &f.policy, &f.scope, &w.sk, d8(9));
    let mut bytes = proof_to_bytes(&prove_eligibility(Fri::Test, &w, &st).unwrap());
    let mid = bytes.len() / 2;
    bytes[mid] ^= 0xFF;
    let ok = proof_from_bytes(&bytes).map(|p| verify_stark(Fri::Test, &p, &st)).unwrap_or(false);
    assert!(!ok, "a tampered proof must be rejected");
}

#[test]
fn forged_trace_height_is_rejected_without_running_the_verifier() {
    let f = fx();
    let w = witness(&f.snap, ME);
    let st = statement(&f.snap, &f.policy, &f.scope, &w.sk, d8(9));
    let mut p = prove_eligibility(Fri::Test, &w, &st).unwrap();
    p.degree_bits = 3; // below the periodic period (red-team finding 2)
    // Without the pin, Plonky3's periodic evaluation underflows: a panic in debug, and in release a loop of
    // about 2^64 steps (observed 2026-11-17: the mutant run hung until killed). So the check runs on a thread
    // with a deadline, and a hang or a panic fails the test instead of stalling the suite.
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(verify_stark(Fri::Test, &p, &st));
    });
    match rx.recv_timeout(std::time::Duration::from_secs(20)) {
        Ok(accepted) => assert!(!accepted, "a proof with a forged height verified"),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => panic!("the verifier hung on a forged height: the height is not pinned"),
        Err(_) => panic!("the verifier panicked on a forged height: the height is not pinned"),
    }
}

// ---- hiding ----------------------------------------------------------------------------------------------

#[test]
fn two_proofs_of_one_eligibility_witness_differ() {
    let f = fx();
    let w = witness(&f.snap, ME);
    let st = statement(&f.snap, &f.policy, &f.scope, &w.sk, d8(9));
    let a = proof_to_bytes(&prove_eligibility(Fri::Test, &w, &st).unwrap());
    let b = proof_to_bytes(&prove_eligibility(Fri::Test, &w, &st).unwrap());
    assert_ne!(a, b, "the blinding randomness is not fresh, so the proof hides nothing");
}

#[test]
fn hiding_margin_holds_for_both_profiles() {
    assert!(HIDING_MARGIN_HOLDS);
    assert!(Fri::Shadow.revealed_per_column() < HEIGHT, "random rows must outnumber what a column reveals");
}

#[test]
fn dependency_graph_has_no_lookup_crates() {
    // Plonky3 #2590: batch-stark LogUp terminals are sent unmasked. This circuit must not depend on them.
    let lock = include_str!("../../Cargo.lock");
    for c in ["p3-lookup", "p3-batch-stark"] {
        assert!(!lock.contains(&format!("name = \"{c}\"")), "{c} entered the dependency graph: read #2590 first");
    }
    assert!(lock.contains("name = \"p3-uni-stark\""), "the check reads the real lockfile");
}

// ---- one hash, one field: Rust and TS agree (kat/eligibility_v0_kat.json from scripts/zkp/eligibility-kat.ts)

fn kat() -> serde_json::Value {
    serde_json::from_str(include_str!("../../kat/eligibility_v0_kat.json")).unwrap()
}
fn digest(v: &serde_json::Value) -> Vec<Val> {
    v.as_array().unwrap().iter().map(|x| Val::from_u64(x.as_str().unwrap().parse().unwrap())).collect()
}

#[test]
fn rust_matches_the_ts_known_answers() {
    let k = kat();
    for c in k["commitment"].as_array().unwrap() {
        let sk: Digest = digest(&c["sk"]).try_into().unwrap();
        assert_eq!(identity_commitment(&sk).to_vec(), digest(&c["idc"]), "commitment != TS commitToSecretFelts");
    }
    let l = &k["leaf"];
    let idc: Digest = digest(&l["idc"]).try_into().unwrap();
    let salt: [Val; 5] = digest(&l["salt"]).try_into().unwrap();
    assert_eq!(leaf(&idc, 742, 20409, &salt).to_vec(), digest(&l["leaf"]));
    let n = &k["nullifier"];
    let sk: Digest = digest(&n["sk"]).try_into().unwrap();
    let scope = Scope {
        domain: n["domain"].as_str().unwrap().into(),
        verifier_id: n["verifier_id"].as_str().unwrap().into(),
        scope_epoch: n["scope_epoch"].as_str().unwrap().into(),
    };
    assert_eq!(nullifier(&sk, &scope).to_vec(), digest(&n["nullifier"]));
    let other = Scope { verifier_id: "trustmarket/sandbox-2".into(), ..scope };
    assert_eq!(nullifier(&sk, &other).to_vec(), digest(&k["nullifier_other_scope"]["nullifier"]));
    let p = Policy::score_gte(500, "repid", "repid-engine/attester/v0", 1);
    assert_eq!(p.canonical_json(), k["policy"]["canonical_json"].as_str().unwrap(), "canonical policy JSON drifted");
    assert_eq!(p.hash().to_vec(), digest(&k["policy"]["policy_hash"]));
}

#[test]
fn one_row_rule_equals_the_full_sponge() {
    let sk = sk_of(3);
    let mut full = enc(COMMIT_TAG);
    full.extend_from_slice(&sk);
    assert_eq!(identity_commitment(&sk), sponge(&full));
    let scope = fx().scope;
    let mut full = scope.prefix();
    full.extend_from_slice(&sk);
    assert_eq!(nullifier(&sk, &scope), sponge(&full));
}

// ---- the verifier procedure (spec §5) ---------------------------------------------------------------------

const TTL: std::time::Duration = std::time::Duration::from_secs(300);

fn verifier(f: &Fx, fri: Fri) -> VerifierState {
    VerifierState::new(f.scope.clone(), fri, TTL)
}

/// Prove agent `i` against a challenge, then present it to `v` (unanchored, as in shadow).
fn present_with(v: &mut VerifierState, f: &Fx, policy: &Policy, i: usize, c: Digest, now: u32) -> Verdict {
    let w = witness(&f.snap, i);
    let st = statement(&f.snap, policy, &f.scope, &w.sk, c);
    let p = prove_eligibility(Fri::Test, &w, &st).unwrap();
    v.present(policy, &c, now, EPOCH, &f.snap.root(), false, &st.nullifier, &p)
}

const SHADOW_UNANCHORED_TEST: [&str; 2] = ["root anchor (EAS)", "test FRI profile (7 conjectured bits)"];

#[test]
fn verifier_accepts_once_and_names_what_it_did_not_check() {
    let f = fx();
    let mut v = verifier(&f, Fri::Test);
    let c = v.issue_challenge();
    assert_eq!(present_with(&mut v, &f, &f.policy, ME, c, EPOCH), Verdict::NotChecked(SHADOW_UNANCHORED_TEST.to_vec()));
}

#[test]
fn only_an_anchored_root_at_shadow_strength_is_eligible() {
    let f = fx();
    let w = witness(&f.snap, ME);
    let mut v = verifier(&f, Fri::Shadow);
    let c = v.issue_challenge();
    let st = statement(&f.snap, &f.policy, &f.scope, &w.sk, c);
    let p = prove_eligibility(Fri::Shadow, &w, &st).unwrap();
    assert_eq!(v.present(&f.policy, &c, EPOCH, EPOCH, &f.snap.root(), true, &st.nullifier, &p), Verdict::Eligible);
    // The same presentation logic at test strength never reads as a pass, anchored or not.
    let mut t = verifier(&f, Fri::Test);
    let c = t.issue_challenge();
    let st = statement(&f.snap, &f.policy, &f.scope, &w.sk, c);
    let p = prove_eligibility(Fri::Test, &w, &st).unwrap();
    assert_eq!(t.present(&f.policy, &c, EPOCH, EPOCH, &f.snap.root(), true, &st.nullifier, &p),
        Verdict::NotChecked(vec!["test FRI profile (7 conjectured bits)"]));
}

#[test]
fn replayed_presentation_is_rejected() {
    let f = fx();
    let mut v = verifier(&f, Fri::Test);
    let c = v.issue_challenge();
    let w = witness(&f.snap, ME);
    let st = statement(&f.snap, &f.policy, &f.scope, &w.sk, c);
    let p = prove_eligibility(Fri::Test, &w, &st).unwrap();
    let go = |v: &mut VerifierState| v.present(&f.policy, &c, EPOCH, EPOCH, &f.snap.root(), false, &st.nullifier, &p);
    assert!(matches!(go(&mut v), Verdict::NotChecked(_)));
    assert!(matches!(go(&mut v), Verdict::NotEligible(_)), "the same presentation twice");
}

#[test]
fn second_presentation_in_one_scope_is_rejected_and_another_scope_is_unlinkable() {
    let f = fx();
    let mut v = verifier(&f, Fri::Test);
    let c1 = v.issue_challenge();
    assert!(matches!(present_with(&mut v, &f, &f.policy, ME, c1, EPOCH), Verdict::NotChecked(_)));
    let c2 = v.issue_challenge();
    assert_eq!(present_with(&mut v, &f, &f.policy, ME, c2, EPOCH), Verdict::NotEligible("nullifier already used in this scope"));
    let other = Scope { verifier_id: "trustmarket/sandbox-2".into(), ..f.scope.clone() };
    assert_ne!(nullifier(&sk_of(ME as u32), &f.scope), nullifier(&sk_of(ME as u32), &other));
}

#[test]
fn uninvited_challenge_and_stale_snapshot_are_rejected() {
    let f = fx();
    let mut v = verifier(&f, Fri::Test);
    assert!(matches!(present_with(&mut v, &f, &f.policy, ME, d8(9), EPOCH), Verdict::NotEligible(_)), "a challenge never issued");
    let c = v.issue_challenge();
    assert_eq!(present_with(&mut v, &f, &f.policy, ME, c, EPOCH + 2), Verdict::NotEligible("snapshot epoch is outside the policy's window"));
}

#[test]
fn expired_challenge_is_rejected() {
    // Interim Codex review 2026-11-17: issued challenges had no expiry.
    let f = fx();
    let mut v = VerifierState::new(f.scope.clone(), Fri::Test, std::time::Duration::ZERO);
    let c = v.issue_challenge();
    std::thread::sleep(std::time::Duration::from_millis(5));
    assert_eq!(present_with(&mut v, &f, &f.policy, ME, c, EPOCH), Verdict::NotEligible("challenge expired"));
}

#[test]
fn policy_for_another_domain_is_rejected() {
    // Interim Codex review 2026-11-17: the verifier never tied the policy's domain to its own scope.
    let f = fx();
    let health = Policy::score_gte(T, "health", "repid-engine/attester/v0", 1);
    let mut v = verifier(&f, Fri::Test);
    let c = v.issue_challenge();
    assert_eq!(present_with(&mut v, &f, &health, ME, c, EPOCH), Verdict::NotEligible("policy domain is not this verifier's domain"));
}

#[test]
fn threshold_near_the_modulus_proves_in_circuit_but_the_verifier_refuses_it() {
    // Free-model idea 2026-11-17 #2, carried over: T = p - 10 makes s - T wrap to s + 10, a small gap. The
    // circuit alone accepts "30 >= 2013265911". Only the verifier's integer range check on T stops it.
    let f = fx();
    let big = Policy::score_gte(Val::ORDER_U32 as u64 - 10, "repid", "repid-engine/attester/v0", 1);
    let mut v = verifier(&f, Fri::Test);
    let c = v.issue_challenge();
    let st = statement(&f.snap, &big, &f.scope, &sk_of(4), c);
    let (r0, r1, h, t, p, _) = honest_parts_below(&f, 4); // score 30
    let proof = prove_spec(Fri::Test, &spec_from(r0, r1, h, t, &p, bits_of(30 + 10)), &st);
    assert!(verify_stark(Fri::Test, &proof, &st), "test construction: the wrapped statement holds in the field");
    assert!(matches!(v.present(&big, &c, EPOCH, EPOCH, &f.snap.root(), false, &st.nullifier, &proof), Verdict::NotEligible(_)));
}
