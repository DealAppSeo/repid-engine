//! # Private eligibility (v0, SHADOW ONLY)
//!
//! Spec: `living-docs/03_specs/ZK_PRIVATE_ELIGIBILITY_v0_2026-11-17.md`. Read it before changing a constraint.
//!
//! Proves: "I hold the identity secret behind one leaf of the snapshot with root R at epoch e, that leaf's
//! score s satisfies s >= T, this is my nullifier for this verifier scope, and this proof answers this
//! challenge." Hidden: s, which leaf, the identity commitment, the secret, the path.
//!
//! Inert by construction: nothing outside this module's tests and `examples/eligibility_bench.rs` calls it,
//! and the crate is not deployed. It is ORIGINAL work (r23): shadow-only until Sean ratifies a measurement.
//! The anchor of R (an EAS attestation) is outside the proof and is reported NOT CHECKED here.
//!
//! ## Trace
//! One Poseidon2 permutation per row (the audited gadget, applied to columns `0..W` through
//! `SubAirBuilder`), then `dir` and 16 gap bits. Row kinds are periodic selector columns the verifier
//! computes itself.
//!
//! | row | permutation input | output lanes 0..8 |
//! |---|---|---|
//! | 0 nullifier | `[sk ‖ PC_null]` | = N |
//! | 1 commitment | `[sk ‖ PC_commit]` | idc |
//! | 2 leaf | `[idc ‖ s, e, LEAF_TAG, salt(5)]` | leaf |
//! | 3 .. 3+D path | `dir ? [sib ‖ cur] : [cur ‖ sib]` | next node; the last = R |
//!
//! No lookups anywhere: Plonky3 #2590 (unmasked LogUp terminals in batch-stark) does not reach this
//! circuit, and `dependency_graph_has_no_lookup_crates` keeps it that way.

use core::borrow::Borrow;
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use p3_air::{Air, BaseAir, PeriodicAirBuilder, WindowAccess};
use p3_baby_bear::default_babybear_poseidon2_16;
use p3_field::{PrimeCharacteristicRing, PrimeField32};
use p3_fri::FriParameters;
use p3_matrix::dense::RowMajorMatrix;
use p3_symmetric::Permutation;
use p3_uni_stark::{prove, verify, Proof, SubAirBuilder};

use crate::{
    generate_trace_rows, hiding_rng, p2_round_constants, Challenger, ChallengeHidingMmcs, Dft, MyCompress,
    FieldHash, HidingPcs, LinearLayers, P2Air, P2Cols, U64Hash, Val, ValHidingMmcs, VaultConfig,
    P2_HALF_FULL_ROUNDS, P2_PARTIAL_ROUNDS, P2_SBOX_DEGREE, P2_SBOX_REGISTERS, P2_WIDTH, W,
};

/// Merkle depth of the snapshot tree (256 leaves).
pub const DEPTH: usize = 8;
/// Trace height. 3 + DEPTH rows carry the statement; the rest are honest padding permutations.
///
/// It is 64, not 16, for ZERO KNOWLEDGE, not for the statement. `HidingFriPcs` interleaves exactly HEIGHT
/// random rows into each column, so each column hides behind HEIGHT random values. The verifier learns, per
/// column, one base-field value per FRI query plus two extension-field openings (zeta and zeta·omega), each
/// worth `EXT_DEGREE` base-field equations. If that count exceeds HEIGHT, the verifier can solve for the
/// real column (sk, s, salt, path). At HEIGHT = 16 with the Shadow profile's 33 queries it would have
/// (33 + 8 > 16). Found by an independent red-team of the spec, 2026-11-17 [reasoned from hiding_pcs.rs
/// and prover.rs; the leak itself is not demonstrated]. `HIDING_MARGIN_HOLDS` pins the inequality.
pub const HEIGHT: usize = 64;
const LOG_HEIGHT: usize = 6;
const EXT_DEGREE: usize = 4;
const _: () = assert!(3 + DEPTH <= HEIGHT && HEIGHT == 1 << LOG_HEIGHT);

pub const COMMIT_TAG: &str = "hyperdag/identity/commitment/v1";
pub const NULLIFIER_TAG: &str = "hyperdag/eligibility/nullifier/v2";
pub const POLICY_TAG: &str = "hyperdag/eligibility/policy/v1";
pub const LEAF_TAG: u32 = 0x4C45_4631; // "LEF1"
/// Names the depth and height too: they are fixed by the AIR, and periodic columns are not in the transcript.
pub const CIRCUIT_ID: &str = "zkp-vault/eligibility/v0/d8-h64";
/// Scores are 10..=10000 (< 2^14). The verifier refuses any policy threshold above this (spec §5 step 1).
pub const MAX_THRESHOLD: u64 = 10_000;
pub const GAP_BITS: usize = 16;

pub type Digest = [Val; 8];

// ---- columns -----------------------------------------------------------------------------------------
const DIR: usize = W;
const BITS: usize = W + 1;
const WIDTH: usize = W + 1 + GAP_BITS;

// periodic selector indices
const S_NULL: usize = 0;
const S_COMMIT: usize = 1;
const S_LEAF: usize = 2;
const S_LINK: usize = 3; // local row's NEXT row is a path row
const S_PATH: usize = 4;
const S_ROOT: usize = 5;

// public value layout (spec §4): T, e, R[8], PC_null[8], N[8], policy_hash[8], c[8]
const PV_T: usize = 0;
const PV_E: usize = 1;
const PV_ROOT: usize = 2;
const PV_PCNULL: usize = 10;
const PV_N: usize = 18;
// policy_hash (26..34) and the challenge (34..42) are in no constraint: the transcript binds them (spec §4 note 2).
pub const NUM_PUBLIC_VALUES: usize = 42;

// ---- off-circuit hashing (one definition, shared with TS through kat/eligibility_v0_kat.json) ---------

/// `enc(s)`: length, then one element per UTF-8 byte (TS `feltsFromString`).
pub fn enc(s: &str) -> Vec<Val> {
    let b = s.as_bytes();
    let mut v = vec![Val::from_u64(b.len() as u64)];
    v.extend(b.iter().map(|&x| Val::from_u64(x as u64)));
    v
}

fn perm(state: [Val; 16]) -> [Val; 16] {
    let mut s = state;
    default_babybear_poseidon2_16().permute_mut(&mut s);
    s
}

fn out8(state: &[Val; 16]) -> Digest {
    state[..8].try_into().unwrap()
}

/// p3 `PaddingFreeSponge<16, 8, 8>` (overwrite mode), as TS `poseidon2Sponge`.
pub fn sponge(input: &[Val]) -> Digest {
    let mut state = [Val::ZERO; 16];
    for chunk in input.chunks(8) {
        state[..chunk.len()].copy_from_slice(chunk);
        state = perm(state);
    }
    out8(&state)
}

/// Capacity lanes (8..16) after absorbing a public prefix of whole blocks. Absorbing the 8-element secret
/// next is then ONE permutation of `[secret ‖ capacity]`: the spec's one-row rule.
pub fn prefix_capacity(prefix: &[Val]) -> Digest {
    assert!(prefix.len() % 8 == 0, "the public prefix must end on a block boundary");
    let mut state = [Val::ZERO; 16];
    for chunk in prefix.chunks(8) {
        state[..8].copy_from_slice(chunk);
        state = perm(state);
    }
    state[8..].try_into().unwrap()
}

fn absorb_secret(secret: &Digest, capacity: &Digest) -> [Val; 16] {
    let mut s = [Val::ZERO; 16];
    s[..8].copy_from_slice(secret);
    s[8..].copy_from_slice(capacity);
    s
}

/// `C(a, b) = Perm(a ‖ b)[0..8]`, as TS `poseidon2Compress`.
pub fn compress(a: &Digest, b: &Digest) -> Digest {
    out8(&perm(absorb_secret(a, b)))
}

fn pc_commit() -> Digest {
    prefix_capacity(&enc(COMMIT_TAG))
}

/// `idc = Sponge(enc(COMMIT_TAG) ‖ sk)`, byte-for-byte TS `commitToSecretFelts`.
pub fn identity_commitment(sk: &Digest) -> Digest {
    out8(&perm(absorb_secret(sk, &pc_commit())))
}

pub fn leaf_tail(score: u32, epoch: u32, salt: &[Val; 5]) -> Digest {
    let mut t = [Val::ZERO; 8];
    t[0] = Val::from_u32(score);
    t[1] = Val::from_u32(epoch);
    t[2] = Val::from_u32(LEAF_TAG);
    t[3..].copy_from_slice(salt);
    t
}

pub fn leaf(idc: &Digest, score: u32, epoch: u32, salt: &[Val; 5]) -> Digest {
    compress(idc, &leaf_tail(score, epoch, salt))
}

/// Verifier scope (spec §3): per-verifier, per-epoch unlinkability comes from the format.
#[derive(Clone, Debug)]
pub struct Scope {
    pub domain: String,
    pub verifier_id: String,
    pub scope_epoch: String,
}

impl Scope {
    fn prefix(&self) -> Vec<Val> {
        let mut p = enc(NULLIFIER_TAG);
        p.extend(enc(&self.domain));
        p.extend(enc(&self.verifier_id));
        p.extend(enc(&self.scope_epoch));
        while p.len() % 8 != 0 {
            p.push(Val::ZERO);
        }
        p
    }
    /// `PC_null`: what the verifier recomputes from its own scope.
    pub fn pc_null(&self) -> Digest {
        prefix_capacity(&self.prefix())
    }
    pub fn key(&self) -> String {
        format!("{}\u{1f}{}\u{1f}{}", self.domain, self.verifier_id, self.scope_epoch)
    }
}

pub fn nullifier(sk: &Digest, scope: &Scope) -> Digest {
    out8(&perm(absorb_secret(sk, &scope.pc_null())))
}

/// The verifier's published policy. Field order is alphabetical, so serde_json emits the canonical form.
#[derive(Clone, Debug, serde::Serialize)]
pub struct Policy {
    pub circuit_id: String,
    pub domain: String,
    pub issuer: String,
    pub max_epoch_age: u32,
    pub predicate: String,
    pub threshold: u64,
}

impl Policy {
    pub fn score_gte(threshold: u64, domain: &str, issuer: &str, max_epoch_age: u32) -> Self {
        Self { circuit_id: CIRCUIT_ID.into(), domain: domain.into(), issuer: issuer.into(), max_epoch_age,
               predicate: "score_gte".into(), threshold }
    }
    pub fn canonical_json(&self) -> String {
        serde_json::to_string(self).expect("policy serializes")
    }
    pub fn hash(&self) -> Digest {
        let mut v = enc(POLICY_TAG);
        v.extend(enc(&self.canonical_json()));
        sponge(&v)
    }
}

// ---- snapshot tree (built by the engine; the agent gets its own path) --------------------------------

pub struct Snapshot {
    pub epoch: u32,
    levels: Vec<Vec<Digest>>, // levels[0] = leaves, levels[DEPTH] = [root]
}

impl Snapshot {
    /// Unused slots are the zero digest; no leaf hashes to zero, so an empty slot is unprovable.
    pub fn new(epoch: u32, leaves: &[Digest]) -> Self {
        assert!(leaves.len() <= 1 << DEPTH);
        let mut level: Vec<Digest> = leaves.to_vec();
        level.resize(1 << DEPTH, [Val::ZERO; 8]);
        let mut levels = vec![level];
        for _ in 0..DEPTH {
            let prev = levels.last().unwrap();
            let next = prev.chunks(2).map(|p| compress(&p[0], &p[1])).collect();
            levels.push(next);
        }
        Self { epoch, levels }
    }
    pub fn root(&self) -> Digest {
        self.levels[DEPTH][0]
    }
    /// (sibling, dir) per level, leaf to root. dir = 1 when the current node is the RIGHT child.
    pub fn path(&self, index: usize) -> Vec<(Digest, bool)> {
        (0..DEPTH)
            .map(|lvl| {
                let i = index >> lvl;
                (self.levels[lvl][i ^ 1], i & 1 == 1)
            })
            .collect()
    }
}

// ---- statement, witness, trace -----------------------------------------------------------------------

/// The public statement, assembled by the VERIFIER from its own policy, scope and challenge.
#[derive(Clone, Debug, PartialEq)]
pub struct Statement {
    pub threshold: u64,
    pub epoch: u32,
    pub root: Digest,
    pub pc_null: Digest,
    pub nullifier: Digest,
    pub policy_hash: Digest,
    pub challenge: Digest,
}

pub fn public_values(st: &Statement) -> Vec<Val> {
    let mut v = vec![Val::from_u64(st.threshold), Val::from_u32(st.epoch)];
    for d in [&st.root, &st.pc_null, &st.nullifier, &st.policy_hash, &st.challenge] {
        v.extend_from_slice(d);
    }
    debug_assert_eq!(v.len(), NUM_PUBLIC_VALUES);
    v
}

pub struct Witness {
    pub sk: Digest,
    pub score: u32,
    pub salt: [Val; 5],
    pub path: Vec<(Digest, bool)>,
}

/// Everything the prover commits to, before Poseidon2 columns are generated. Forgery tests edit this.
#[derive(Clone)]
pub struct TraceSpec {
    pub inputs: Vec<[Val; 16]>, // HEIGHT permutation inputs
    pub dir: Vec<Val>,          // HEIGHT
    pub bits: [Val; GAP_BITS],  // the leaf row's gap bits
}

#[derive(Debug, PartialEq)]
pub enum ProveError {
    BelowThreshold,
    WrongPathLength,
}

/// The honest trace for `w` against `st`. Refuses when s < T or the gap does not fit in 16 bits.
pub fn honest_spec(w: &Witness, st: &Statement) -> Result<TraceSpec, ProveError> {
    if w.path.len() != DEPTH {
        return Err(ProveError::WrongPathLength);
    }
    let gap = (w.score as i64) - (st.threshold as i64);
    if gap < 0 || gap >= 1 << GAP_BITS {
        return Err(ProveError::BelowThreshold);
    }
    let mut inputs = vec![[Val::ZERO; 16]; HEIGHT];
    let mut dir = vec![Val::ZERO; HEIGHT];
    inputs[0] = absorb_secret(&w.sk, &st.pc_null);
    inputs[1] = absorb_secret(&w.sk, &pc_commit());
    let idc = out8(&perm(inputs[1]));
    inputs[2] = absorb_secret(&idc, &leaf_tail(w.score, st.epoch, &w.salt));
    let mut cur = out8(&perm(inputs[2]));
    for (k, (sib, d)) in w.path.iter().enumerate() {
        let row = 3 + k;
        inputs[row] = if *d { absorb_secret(sib, &cur) } else { absorb_secret(&cur, sib) };
        dir[row] = Val::from_bool(*d);
        cur = out8(&perm(inputs[row]));
    }
    let bits = core::array::from_fn(|k| Val::from_bool((gap >> k) & 1 == 1));
    Ok(TraceSpec { inputs, dir, bits })
}

pub fn trace_from(spec: &TraceSpec) -> RowMajorMatrix<Val> {
    let p2 = generate_trace_rows::<
        Val, LinearLayers, P2_WIDTH, P2_SBOX_DEGREE, P2_SBOX_REGISTERS, P2_HALF_FULL_ROUNDS, P2_PARTIAL_ROUNDS,
    >(spec.inputs.clone(), &p2_round_constants(), 0);
    let mut values = Vec::with_capacity(HEIGHT * WIDTH);
    for r in 0..HEIGHT {
        values.extend_from_slice(&p2.values[r * W..(r + 1) * W]);
        values.push(spec.dir[r]);
        if r == 2 {
            values.extend_from_slice(&spec.bits);
        } else {
            values.extend_from_slice(&[Val::ZERO; GAP_BITS]);
        }
    }
    RowMajorMatrix::new(values, WIDTH)
}

// ---- the AIR -----------------------------------------------------------------------------------------

pub struct EligibilityAir {
    p2: P2Air,
    pc_commit: Digest,
}

impl EligibilityAir {
    pub fn new() -> Self {
        Self { p2: P2Air::new(p2_round_constants()), pc_commit: pc_commit() }
    }
}

impl Default for EligibilityAir {
    fn default() -> Self {
        Self::new()
    }
}

fn selector(rows: impl Fn(usize) -> bool) -> Vec<Val> {
    (0..HEIGHT).map(|r| Val::from_bool(rows(r))).collect()
}

impl BaseAir<Val> for EligibilityAir {
    fn width(&self) -> usize {
        WIDTH
    }
    fn num_public_values(&self) -> usize {
        NUM_PUBLIC_VALUES
    }
    fn num_periodic_columns(&self) -> usize {
        6
    }
    fn periodic_columns(&self) -> Vec<Vec<Val>> {
        vec![
            selector(|r| r == 0),
            selector(|r| r == 1),
            selector(|r| r == 2),
            selector(|r| (2..2 + DEPTH).contains(&r)),
            selector(|r| (3..3 + DEPTH).contains(&r)),
            selector(|r| r == 2 + DEPTH),
        ]
    }
}

impl<AB> Air<AB> for EligibilityAir
where
    AB: PeriodicAirBuilder<F = Val>,
{
    fn eval(&self, builder: &mut AB) {
        // The audited Poseidon2 constraints on columns 0..W of every row.
        {
            let mut sub = SubAirBuilder::<AB, P2Air, Val>::new(builder, 0..W);
            self.p2.eval(&mut sub);
        }

        let sel: Vec<AB::Expr> = builder.periodic_values().iter().map(|v| (*v).into()).collect();
        let pv: Vec<AB::Expr> = builder.public_values().iter().map(|v| (*v).into()).collect();
        let (in_l, out_l, dir_l, bits, in_n, dir_n) = {
            let main = builder.main();
            let (local, next) = (main.current_slice(), main.next_slice());
            let lc: &P2Cols<AB::Var> = local[..W].borrow();
            let nc: &P2Cols<AB::Var> = next[..W].borrow();
            let e = |v: &AB::Var| -> AB::Expr { (*v).into() };
            (
                lc.inputs.iter().map(e).collect::<Vec<_>>(),
                lc.ending_full_rounds[P2_HALF_FULL_ROUNDS - 1].post[..8].iter().map(e).collect::<Vec<_>>(),
                e(&local[DIR]),
                local[BITS..BITS + GAP_BITS].iter().map(e).collect::<Vec<_>>(),
                nc.inputs.iter().map(e).collect::<Vec<_>>(),
                e(&next[DIR]),
            )
        };
        let one = AB::Expr::ONE;

        for j in 0..8 {
            // C1 nullifier row absorbs the verifier's scope prefix.
            builder.assert_zero(sel[S_NULL].clone() * (in_l[8 + j].clone() - pv[PV_PCNULL + j].clone()));
            // C2 its output is the published nullifier.
            builder.assert_zero(sel[S_NULL].clone() * (out_l[j].clone() - pv[PV_N + j].clone()));
            // C3 the commitment row hashes the SAME secret.
            builder.assert_zero(sel[S_NULL].clone() * (in_n[j].clone() - in_l[j].clone()));
            // C4 the commitment row absorbs the fixed commitment prefix.
            builder.assert_zero(sel[S_COMMIT].clone() * (in_l[8 + j].clone() - AB::Expr::from(self.pc_commit[j])));
            // C5 the leaf row names THIS identity commitment.
            builder.assert_zero(sel[S_COMMIT].clone() * (in_n[j].clone() - out_l[j].clone()));
            // C10 each path row hashes the current node into the half its dir names.
            builder.assert_zero(
                sel[S_LINK].clone()
                    * ((one.clone() - dir_n.clone()) * (in_n[j].clone() - out_l[j].clone())
                        + dir_n.clone() * (in_n[8 + j].clone() - out_l[j].clone())),
            );
            // C11 the last path row reaches the anchored root.
            builder.assert_zero(sel[S_ROOT].clone() * (out_l[j].clone() - pv[PV_ROOT + j].clone()));
        }
        // C6 the leaf's epoch and format tag.
        builder.assert_zero(sel[S_LEAF].clone() * (in_l[9].clone() - pv[PV_E].clone()));
        builder.assert_zero(sel[S_LEAF].clone() * (in_l[10].clone() - AB::Expr::from(Val::from_u32(LEAF_TAG))));
        // C7 gap bits are boolean.
        for b in &bits {
            builder.assert_zero(sel[S_LEAF].clone() * b.clone() * (b.clone() - one.clone()));
        }
        // C8 the gap is s - T.
        let mut sum = AB::Expr::ZERO;
        for (k, b) in bits.iter().enumerate() {
            sum += b.clone() * AB::Expr::from(Val::from_u32(1 << k));
        }
        builder.assert_zero(sel[S_LEAF].clone() * (sum - (in_l[8].clone() - pv[PV_T].clone())));
        // C9 dir is boolean on path rows.
        builder.assert_zero(sel[S_PATH].clone() * dir_l.clone() * (dir_l - one));
    }
}

// ---- config, prove, verify ---------------------------------------------------------------------------

/// FRI parameters (spec §7). `Test` is for gates only (7 conjectured bits). `Shadow` is ~100 conjectured
/// bits; the bench and any shadow run use it and say so.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Fri {
    Test,
    Shadow,
}

impl Fri {
    pub fn num_queries(self) -> usize {
        match self {
            Fri::Test => 2,
            Fri::Shadow => 33,
        }
    }
    pub fn conjectured_bits(self) -> usize {
        3 * self.num_queries() + 1
    }
    /// Base-field facts the verifier learns about each trace column (see [`HEIGHT`]).
    pub const fn revealed_per_column(self) -> usize {
        (match self {
            Fri::Test => 2,
            Fri::Shadow => 33,
        }) + 2 * EXT_DEGREE
    }
}

/// The hiding margin: the random rows per column outnumber what the verifier learns about it, in both profiles.
pub const HIDING_MARGIN_HOLDS: bool =
    Fri::Shadow.revealed_per_column() < HEIGHT && Fri::Test.revealed_per_column() < HEIGHT;
const _: () = assert!(HIDING_MARGIN_HOLDS);

pub fn config(fri: Fri) -> VaultConfig {
    let u64_hash = U64Hash::new(p3_keccak::KeccakF {});
    let field_hash = FieldHash::new(u64_hash);
    let compress_fn = MyCompress::new(u64_hash);
    let challenge_mmcs = ChallengeHidingMmcs::new(ValHidingMmcs::new(field_hash, compress_fn.clone(), 0, hiding_rng()));
    let val_mmcs = ValHidingMmcs::new(field_hash, compress_fn, 0, hiding_rng());
    let fri_params = FriParameters {
        log_blowup: 3,
        log_final_poly_len: 2,
        max_log_arity: 1,
        num_queries: fri.num_queries(),
        commit_proof_of_work_bits: 0,
        query_proof_of_work_bits: 1,
        mmcs: challenge_mmcs,
    };
    let pcs = HidingPcs::new(Dft::default(), val_mmcs, fri_params, 4, hiding_rng());
    VaultConfig::new(pcs, Challenger::from_hasher(vec![], p3_keccak::Keccak256Hash {}))
}

pub type EligibilityProof = Proof<VaultConfig>;

pub fn prove_spec(fri: Fri, spec: &TraceSpec, st: &Statement) -> EligibilityProof {
    prove(&config(fri), &EligibilityAir::new(), trace_from(spec), &public_values(st))
}

pub fn prove_eligibility(fri: Fri, w: &Witness, st: &Statement) -> Result<EligibilityProof, ProveError> {
    Ok(prove_spec(fri, &honest_spec(w, st)?, st))
}

/// The STARK check alone. A verifier never calls this directly: use [`VerifierState::present`].
/// The trace height is PINNED here: Plonky3 takes it from the proof, and a forged smaller height makes the
/// periodic-column evaluation underflow (a panic in debug, a near-endless loop in release) [red-team 2026-11-17].
pub fn verify_stark(fri: Fri, proof: &EligibilityProof, st: &Statement) -> bool {
    if proof.degree_bits != EXPECTED_DEGREE_BITS {
        return false;
    }
    verify(&config(fri), &EligibilityAir::new(), proof, &public_values(st)).is_ok()
}

/// log2(HEIGHT), plus 1 because the hiding PCS doubles the committed height.
pub const EXPECTED_DEGREE_BITS: usize = LOG_HEIGHT + 1;

pub fn proof_to_bytes(p: &EligibilityProof) -> Vec<u8> {
    bincode::serialize(p).expect("proof serializes")
}

pub fn proof_from_bytes(b: &[u8]) -> Result<EligibilityProof, bincode::Error> {
    bincode::deserialize(b)
}

// ---- the verifier procedure (spec §5) ----------------------------------------------------------------

#[derive(Debug, PartialEq)]
pub enum Verdict {
    /// Every required check ran and passed.
    Eligible,
    NotEligible(&'static str),
    /// Every check that ran passed, and these did not run (or ran at test strength). Never a pass (spec §5).
    /// In shadow this always names the root anchor.
    NotChecked(Vec<&'static str>),
}

fn key8(d: &Digest) -> [u32; 8] {
    d.map(|x| x.as_canonical_u32())
}

/// One verifier: its OWN scope and FRI profile (never taken from a presentation), the challenges it issued
/// with their issue time, and the nullifiers it has seen in its scope. Interim Codex review, 2026-11-17:
/// a scope or profile passed in per call lets a caller pick a fresh scope (a fresh nullifier) or a 7-bit
/// profile per presentation.
pub struct VerifierState {
    scope: Scope,
    fri: Fri,
    challenge_ttl: Duration,
    issued: HashMap<[u32; 8], Instant>,
    seen: HashSet<[u32; 8]>,
}

impl VerifierState {
    pub fn new(scope: Scope, fri: Fri, challenge_ttl: Duration) -> Self {
        Self { scope, fri, challenge_ttl, issued: HashMap::new(), seen: HashSet::new() }
    }

    pub fn scope(&self) -> &Scope {
        &self.scope
    }

    pub fn issue_challenge(&mut self) -> Digest {
        use rand::RngExt;
        let mut rng = hiding_rng();
        let c: Digest = core::array::from_fn(|_| Val::from_u32(rng.random_range(0..Val::ORDER_U32)));
        self.issued.insert(key8(&c), Instant::now());
        c
    }

    /// Check one presentation. The statement is assembled HERE from the verifier's own policy, scope and
    /// challenge; the prover supplies only (epoch, root, nullifier, proof). `root_anchored` is whether the
    /// caller checked R's EAS anchor; in shadow it is false and the verdict is NotChecked.
    #[allow(clippy::too_many_arguments)]
    pub fn present(
        &mut self,
        policy: &Policy,
        challenge: &Digest,
        current_epoch: u32,
        epoch: u32,
        root: &Digest,
        root_anchored: bool,
        claimed_nullifier: &Digest,
        proof: &EligibilityProof,
    ) -> Verdict {
        // 1. Threshold from the verifier's own policy, in range (else s - T wraps: attack idea 2026-11-17 #2).
        if policy.predicate != "score_gte" || policy.circuit_id != CIRCUIT_ID || policy.threshold > MAX_THRESHOLD {
            return Verdict::NotEligible("policy is not a score_gte policy for this circuit, or T is out of range");
        }
        if policy.domain != self.scope.domain {
            return Verdict::NotEligible("policy domain is not this verifier's domain");
        }
        // 3. A challenge this verifier issued, unexpired, not yet answered.
        match self.issued.get(&key8(challenge)) {
            None => return Verdict::NotEligible("challenge was not issued by this verifier, or was already used"),
            Some(at) if at.elapsed() > self.challenge_ttl => {
                self.issued.remove(&key8(challenge));
                return Verdict::NotEligible("challenge expired");
            }
            Some(_) => {}
        }
        // 4 (epoch half). The anchor half is the caller's.
        if epoch > current_epoch || current_epoch - epoch > policy.max_epoch_age {
            return Verdict::NotEligible("snapshot epoch is outside the policy's window");
        }
        // 5. Nullifier not seen in this scope.
        if self.seen.contains(&key8(claimed_nullifier)) {
            return Verdict::NotEligible("nullifier already used in this scope");
        }
        // 2 + 6. PC_null and the policy hash recomputed here, then the STARK.
        let st = Statement {
            threshold: policy.threshold,
            epoch,
            root: *root,
            pc_null: self.scope.pc_null(),
            nullifier: *claimed_nullifier,
            policy_hash: policy.hash(),
            challenge: *challenge,
        };
        if !verify_stark(self.fri, proof, &st) {
            return Verdict::NotEligible("proof does not verify against this statement");
        }
        self.issued.remove(&key8(challenge));
        self.seen.insert(key8(claimed_nullifier));
        let mut not_checked = vec![];
        if !root_anchored {
            not_checked.push("root anchor (EAS)");
        }
        if self.fri == Fri::Test {
            not_checked.push("test FRI profile (7 conjectured bits)");
        }
        if not_checked.is_empty() { Verdict::Eligible } else { Verdict::NotChecked(not_checked) }
    }
}

#[cfg(test)]
mod tests;
