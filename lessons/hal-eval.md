<!-- triggers: hal f1 provider quorum corpus eval evaluation hallucination veto classify accuracy precision recall calibration ruler score scoring known-answer answer-key reveal commitment rehearsal -->
# HAL / evaluation / measurement lessons

Full narratives behind LESSONS §4 and §8. Appended when a brief concerns HAL or measurement.

## Evidence outranks the label (§4)
`event_type` is caller-supplied, so it can never *upgrade* trust — an agent picks its own label.
Re-classifying the RepID ledger on the hardest-to-forge artifact present (contract, on-chain
attestation, ZK proof, settled economic impact) showed **97.5% of score gained is externally
verifiable**, which only became knowable by ignoring the labels. Classify on the artifact, never
on the self-reported field.

## A measurement without its ruler is not a result (§8)
HAL F1 has been quoted at **0.34 / 0.74 / 0.886 / 0.890** — four different corpora and
configurations, so "did HAL improve?" has no answer as posed. On 2026-08-09 F1 appeared to fall
0.908 → 0.877; the cause was **providers running out of credit mid-run**, not a quality change —
a dead-key failure misread as a math/scoring regression sent someone hunting a bug that did not
exist. Roughly two-thirds of vetoing hallucination penalties historically ran with a failed
provider in the quorum, and only a handful had a full provider set *and* a real disagreement.

**Apply:** every accuracy number carries its corpus hash and the configuration width —
"F1 = x on corpus v1 @ `hash` at N families". Record per-provider failures beside the number.
Numbers on different rulers are never compared, trended, or called progress. A test that fails
because a provider key died must say *that*, not report a quality regression. Use a credible
interval for **gating** (widening is the conservative direction); never publish it as a
calibrated probability — reputation agents adapt, so exchangeability is violated exactly on the
adversarial cases that matter.

## Score the whole set, or void the score (§7, 2026-11-14)
A score over a set of items is only honest if the set was fixed before anyone answered and every
item in it is either scored or voids the score. If anything can make an item drop out, whoever can
trigger the drop wins whenever that item would have cost them: an exclusion becomes cheaper than
the penalty it avoids.

On #1544 (grading T12 known-answer work against a commit-reveal answer key) three reviews found
three doors of the same shape within an hour:
- **Strix:** deleting the stored commitment from a task row made the task drop out instead of
  costing −(1 + confidence).
- **Grok R2-1:** blanking the result after grading made the wrong answer "unscorable".
- **Grok R2-2:** a reveal file could simply leave the wrong answers out.

The first fix closed one door and did not generalise, which is why the second review found two more.
What closed all three:
- the set's hash is published before dispatch;
- the reveal must cover every dispatched task;
- each item is bound to the exact reply and claimer that were graded;
- ANY rejection makes the run "not clean", with nothing settled.

**Apply:** before fixing a finding about a score, list every path that removes an item from the
scored set (reject, skip, not scorable, filter, missing entry, unpaged read) and ask who can trigger
it and whether they gain. Fix them in one change, with a test per path that goes red when its check
is removed.
