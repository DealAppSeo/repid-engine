//! # Threshold tier (SHADOW ONLY)
//!
//! `prove_threshold_tier` is an eligibility proof ([`crate::eligibility`]) whose threshold is a RepID tier
//! floor. No new constraint: the circuit, its C1..C11 and its mutants are unchanged.
//!
//! **The tier is DERIVED, never taken.** The verifier tries each tier's policy, highest floor first, and the
//! tier is the one whose floor the proof verifies under. The floor is a public value observed into the
//! transcript (through the threshold and the policy hash), so a proof made at one floor does not verify at
//! another. A tier the presentation names ([`TierPresentation::claimed_tier`]) is never the answer: when it
//! disagrees with the derived tier, the presentation is refused.
//!
//! **Bound to:** the snapshot (the verifier's OWN root for the epoch, never the presented one, and the epoch
//! through the leaf row), and the subject as this circuit knows it: the holder of the identity secret behind
//! one leaf, seen as its nullifier in this verifier's scope. Not bound to a public agent id: the circuit hides
//! which leaf proved.
//!
//! **What it is not.** A floor proof says "score >= floor". It is a lower bound: a holder may present a lower
//! tier, never a higher one. It is the SCORE BAND only. The database tier also demotes AUTONOMOUS and VETERAN
//! below 2 unique counterparties (`compute_tier(integer, uuid)`), and this proof knows nothing of
//! counterparties, so for those two bands it can disagree with the displayed database tier.
//!
//! Display rule: [`TierCheck::displayable`] is `Some` only for [`Verdict::Eligible`], which needs an anchored
//! root and the Shadow FRI profile. Nothing anchors a root today, so nothing is displayable: shadow by
//! construction. ORIGINAL work (r23): shadow until Sean ratifies a measurement.

use crate::eligibility::{
    nullifier, prove_eligibility, Digest, EligibilityProof, Fri, Policy, ProveError, Scope, Statement, Verdict,
    VerifierState, Witness, PROOF_DOES_NOT_VERIFY,
};

/// The canonical score bands (`repid_agents_tier_check`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tier {
    Probationary,
    Earning,
    Established,
    Autonomous,
    Veteran,
}

impl Tier {
    /// Highest floor first: the order the verifier tries.
    pub const ALL: [Tier; 5] = [Tier::Veteran, Tier::Autonomous, Tier::Established, Tier::Earning, Tier::Probationary];

    pub const fn floor(self) -> u64 {
        match self {
            Tier::Probationary => 0,
            Tier::Earning => 500,
            Tier::Established => 1000,
            Tier::Autonomous => 5000,
            Tier::Veteran => 8000,
        }
    }
}

pub fn tier_policy(tier: Tier, domain: &str, issuer: &str, max_epoch_age: u32) -> Policy {
    Policy::score_gte(tier.floor(), domain, issuer, max_epoch_age)
}

/// What the prover sends. `root` and `claimed_tier` are the prover's words: the verifier checks the first
/// against its own record and never answers with the second.
pub struct TierPresentation {
    pub epoch: u32,
    pub root: Digest,
    pub nullifier: Digest,
    pub proof: EligibilityProof,
    pub claimed_tier: Option<Tier>,
}

/// Prove "my score is at least `tier`'s floor" for the leaf `w` opens in the snapshot `(epoch, root)`.
/// Refuses (`BelowThreshold`) when the score is below the floor.
#[allow(clippy::too_many_arguments)]
pub fn prove_threshold_tier(
    fri: Fri,
    w: &Witness,
    tier: Tier,
    scope: &Scope,
    issuer: &str,
    max_epoch_age: u32,
    epoch: u32,
    root: &Digest,
    challenge: &Digest,
) -> Result<TierPresentation, ProveError> {
    let policy = tier_policy(tier, &scope.domain, issuer, max_epoch_age);
    let st = Statement {
        threshold: policy.threshold,
        epoch,
        root: *root,
        pc_null: scope.pc_null(),
        nullifier: nullifier(&w.sk, scope),
        policy_hash: policy.hash(),
        challenge: *challenge,
    };
    let proof = prove_eligibility(fri, w, &st)?;
    Ok(TierPresentation { epoch, root: *root, nullifier: st.nullifier, proof, claimed_tier: Some(tier) })
}

#[derive(Debug, PartialEq)]
pub struct TierCheck {
    /// The tier whose floor the proof verified under. `None` when nothing verified or a check refused.
    pub tier: Option<Tier>,
    pub verdict: Verdict,
}

impl TierCheck {
    /// The only tier a page may show: every check ran and passed.
    pub fn displayable(&self) -> Option<Tier> {
        if self.verdict == Verdict::Eligible { self.tier } else { None }
    }
}

impl VerifierState {
    /// Check a tier presentation. `snapshot_root` is the verifier's OWN record of the root for `p.epoch`
    /// (from the engine's published snapshot), and `root_anchored` whether its EAS anchor was checked.
    #[allow(clippy::too_many_arguments)]
    pub fn present_tier(
        &mut self,
        issuer: &str,
        max_epoch_age: u32,
        challenge: &Digest,
        current_epoch: u32,
        snapshot_root: &Digest,
        root_anchored: bool,
        p: &TierPresentation,
    ) -> TierCheck {
        let refuse = |why: &'static str| TierCheck { tier: None, verdict: Verdict::NotEligible(why) };
        if p.root != *snapshot_root {
            return refuse("presented root is not this verifier's snapshot for that epoch");
        }
        let domain = self.scope().domain.clone();
        for t in Tier::ALL {
            let policy = tier_policy(t, &domain, issuer, max_epoch_age);
            match self.present(&policy, challenge, current_epoch, p.epoch, snapshot_root, root_anchored, &p.nullifier, &p.proof) {
                // A STARK failure changes no verifier state, so the next floor is a clean try.
                Verdict::NotEligible(why) if why == PROOF_DOES_NOT_VERIFY => continue,
                Verdict::NotEligible(why) => return refuse(why),
                verdict => {
                    if p.claimed_tier.is_some_and(|c| c != t) {
                        return refuse("claimed tier is not the tier the proof verifies at");
                    }
                    return TierCheck { tier: Some(t), verdict };
                }
            }
        }
        refuse(PROOF_DOES_NOT_VERIFY)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::eligibility::{identity_commitment, leaf, verify_stark, Snapshot};
    use crate::Val;
    use p3_field::PrimeCharacteristicRing;
    use std::time::Duration;

    const EPOCH: u32 = 20409;
    const ME: usize = 5; // score 742: EARNING
    const SCORES: [u32; 8] = [120, 980, 499, 10_000, 30, 742, 500, 15];
    const ISSUER: &str = "repid-engine/attester/v0";

    fn sk_of(i: usize) -> Digest {
        core::array::from_fn(|k| Val::from_u32(1000 * (i as u32 + 1) + k as u32 + 1))
    }
    fn salt_of(i: usize) -> [Val; 5] {
        core::array::from_fn(|k| Val::from_u32(77_000 + 10 * i as u32 + k as u32))
    }
    fn snapshot(epoch: u32, scores: &[u32]) -> Snapshot {
        let leaves: Vec<Digest> =
            (0..scores.len()).map(|i| leaf(&identity_commitment(&sk_of(i)), scores[i], epoch, &salt_of(i))).collect();
        Snapshot::new(epoch, &leaves)
    }
    fn witness(snap: &Snapshot, i: usize, scores: &[u32]) -> Witness {
        Witness { sk: sk_of(i), score: scores[i], salt: salt_of(i), path: snap.path(i) }
    }
    fn scope() -> Scope {
        Scope { domain: "repid".into(), verifier_id: "trustshell/tier-display".into(), scope_epoch: "2026-11-18".into() }
    }
    fn verifier(fri: Fri) -> VerifierState {
        VerifierState::new(scope(), fri, Duration::from_secs(300))
    }

    /// One fresh verifier, one challenge, one honest EARNING presentation for `ME` against `snap`.
    fn earning(fri: Fri, snap: &Snapshot) -> (VerifierState, Digest, TierPresentation) {
        let mut v = verifier(fri);
        let c = v.issue_challenge();
        let p = prove_threshold_tier(fri, &witness(snap, ME, &SCORES), Tier::Earning, &scope(), ISSUER, 1, snap.epoch, &snap.root(), &c)
            .expect("742 >= 500 proves");
        (v, c, p)
    }

    #[test]
    fn a_valid_tier_proof_derives_the_tier_it_was_made_at() {
        let snap = snapshot(EPOCH, &SCORES);
        let (mut v, c, p) = earning(Fri::Test, &snap);
        let got = v.present_tier(ISSUER, 1, &c, EPOCH, &snap.root(), false, &p);
        assert_eq!(got.tier, Some(Tier::Earning));
        // Unanchored root + test profile: verified, but never shown.
        assert!(matches!(got.verdict, Verdict::NotChecked(_)), "{:?}", got.verdict);
        assert_eq!(got.displayable(), None);
    }

    #[test]
    fn only_an_anchored_root_at_shadow_strength_is_displayable() {
        let snap = snapshot(EPOCH, &SCORES);
        let (mut v, c, p) = earning(Fri::Shadow, &snap);
        let got = v.present_tier(ISSUER, 1, &c, EPOCH, &snap.root(), true, &p);
        assert_eq!(got, TierCheck { tier: Some(Tier::Earning), verdict: Verdict::Eligible });
        assert_eq!(got.displayable(), Some(Tier::Earning));
    }

    /// (a) The presentation says VETERAN; the proof is an EARNING proof. The claim is never the answer.
    #[test]
    fn a_claimed_tier_override_is_refused() {
        let snap = snapshot(EPOCH, &SCORES);
        let (mut v, c, mut p) = earning(Fri::Test, &snap);
        p.claimed_tier = Some(Tier::Veteran);
        let got = v.present_tier(ISSUER, 1, &c, EPOCH, &snap.root(), true, &p);
        assert_eq!(got.tier, None, "a caller-supplied tier reached the result: {got:?}");
        assert_eq!(got.verdict, Verdict::NotEligible("claimed tier is not the tier the proof verifies at"));
    }

    /// (b) An EARNING proof does not verify at any other floor, and the prover cannot make a higher one.
    #[test]
    fn a_changed_tier_fails_verification() {
        let snap = snapshot(EPOCH, &SCORES);
        let (mut v, c, p) = earning(Fri::Test, &snap);
        for t in [Tier::Veteran, Tier::Autonomous, Tier::Established, Tier::Probationary] {
            let policy = tier_policy(t, "repid", ISSUER, 1);
            let st = Statement {
                threshold: policy.threshold,
                epoch: EPOCH,
                root: snap.root(),
                pc_null: scope().pc_null(),
                nullifier: p.nullifier,
                policy_hash: policy.hash(),
                challenge: c,
            };
            assert!(!verify_stark(Fri::Test, &p.proof, &st), "an EARNING proof verified at {t:?}");
        }
        let mut no_claim = p;
        no_claim.claimed_tier = None;
        assert_eq!(v.present_tier(ISSUER, 1, &c, EPOCH, &snap.root(), false, &no_claim).tier, Some(Tier::Earning));
        let c2 = v.issue_challenge();
        let up = prove_threshold_tier(Fri::Test, &witness(&snap, ME, &SCORES), Tier::Established, &scope(), ISSUER, 1, EPOCH, &snap.root(), &c2);
        assert!(matches!(up, Err(ProveError::BelowThreshold)));
    }

    /// (c) A valid proof against snapshot A, presented to a verifier whose snapshot is B, is refused, whether
    /// the presentation names A's root or B's. Same for the epoch.
    #[test]
    fn a_valid_proof_with_the_wrong_snapshot_fails() {
        let a = snapshot(EPOCH, &SCORES);
        let mut later = SCORES;
        later[0] = 121; // one other agent moved: a different snapshot, ME's leaf unchanged
        let b = snapshot(EPOCH, &later);
        assert_ne!(a.root(), b.root());

        let (mut v, c, mut p) = earning(Fri::Test, &a);
        let got = v.present_tier(ISSUER, 1, &c, EPOCH, &b.root(), false, &p);
        assert_eq!(got.tier, None, "proof for snapshot A accepted against B: {got:?}");
        p.root = b.root();
        let got = v.present_tier(ISSUER, 1, &c, EPOCH, &b.root(), false, &p);
        assert_eq!(got, TierCheck { tier: None, verdict: Verdict::NotEligible(PROOF_DOES_NOT_VERIFY) });

        // Same leaves, the next epoch: the root is equal, the leaf row binds the epoch.
        let (mut v, c, mut p) = earning(Fri::Test, &a);
        p.epoch = EPOCH + 1;
        let got = v.present_tier(ISSUER, 1, &c, EPOCH + 1, &a.root(), false, &p);
        assert_eq!(got, TierCheck { tier: None, verdict: Verdict::NotEligible(PROOF_DOES_NOT_VERIFY) });
    }

    /// The subject: a valid proof under another nullifier is refused.
    #[test]
    fn a_valid_proof_for_another_subject_fails() {
        let snap = snapshot(EPOCH, &SCORES);
        let (mut v, c, mut p) = earning(Fri::Test, &snap);
        p.nullifier = nullifier(&sk_of(1), &scope());
        let got = v.present_tier(ISSUER, 1, &c, EPOCH, &snap.root(), false, &p);
        assert_eq!(got, TierCheck { tier: None, verdict: Verdict::NotEligible(PROOF_DOES_NOT_VERIFY) });
    }
}
