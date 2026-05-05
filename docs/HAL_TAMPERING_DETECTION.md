# HAL Tampering Detection (Strictness Level 5)

**Status:** v0.1 (informational flag, not auto-veto)
**Wired in:** `src/hal/lib/evaluate.ts` at strictness level 5
**Ships with:** Wave 5 sprint, 2026-05-04

---

## What it is

When HAL evaluates a prompt at strictness level 5, the cross-LLM
consensus is classified into one of three zones around the Pythagorean
Comma similarity band (`src/hal/lib/zones.ts`):

| Zone | Similarity | Meaning |
|---|---|---|
| `too-tight` | > 0.99 | Suspiciously perfect agreement → tampering flag |
| `in-band` | 0.95 – 0.99 | Trusted consensus (proceeds to claim comparison) |
| `too-loose` | ≤ 0.95 | Uncertainty (no consensus) |

When the zone is `too-tight` AND strictness is 5, HAL populates
`HALResult.tampering_suspected = true` and a `tampering_signal` object
with the similarity score, the raw provider responses (for human
review), and a human-readable reason.

The flag is INFORMATIONAL. It does NOT auto-veto in v0.1. Downstream
callers decide whether to:

- Review responses manually before serving the answer
- Escalate to a second-line model
- Quarantine the prompt and retrain
- Veto outright (custom policy)

---

## Why too-tight agreement is suspicious

The Pythagorean Comma exists because perfect harmonization is
mathematically impossible across systems — twelve perfect fifths do
not exactly equal seven octaves; the residual is the comma. Sean's
design carries this insight into cross-LLM consensus: independent LLMs
producing **byte-identical or near-identical** answers is structurally
suspicious.

Causes that can produce too-tight agreement:

1. **Memorized training data.** If all three providers were trained on
   the same Wikipedia paragraph, they emit the same paragraph. The
   answer may still be correct, but the system is no longer doing
   independent reasoning — and what's correct on a memorized fact may
   be wrong elsewhere from the same source.
2. **Coordinated prompt injection.** A successful supply-chain attack
   that places identical instructions into the system prompts of all
   three providers will produce identical outputs.
3. **Training-data contamination.** Adversarial content seeded into
   widely-used corpora (CommonCrawl, OpenAssistant, etc.) will appear
   verbatim in multiple model outputs.
4. **Provider collusion or shared backend.** Two "different" providers
   may actually proxy the same underlying model. Tight agreement
   reveals what the API names try to hide.

In domains where lives or money depend on the answer (legal, medical,
financial, regulatory), the right policy is to treat tight agreement
as a signal to STOP and have a human verify.

---

## How to use the flag

### Inspecting the signal

```ts
const result = await evaluate(claim, output, { ...context, strictness: 5 });
if (result.tampering_suspected) {
  console.warn(
    'HAL tampering signal:',
    result.tampering_signal!.reason,
    'similarity =', result.tampering_signal!.similarity,
  );
  // Consider: block, escalate, log, retrain.
}
```

### Distinguishing legitimate-tight from suspicious-tight

Some queries SHOULD produce tight agreement — straightforward factual
lookups (capital cities, sums of small numbers, definitions of common
terms). Others should NOT — novel claims, multi-step reasoning,
opinion-shaped questions.

A simple heuristic: if the prompt category from the Layer 0 classifier
is `factual` or `time-sensitive` AND the answer is short (≤ 1 sentence),
tight agreement is probably legitimate. If the prompt is `math`,
`code`, or asks about reasoning chains, tight agreement is more
suspicious.

This heuristic is NOT auto-applied in v0.1. The library surfaces the
flag and the responses; the caller decides.

---

## What's NOT in this version

- **No auto-veto.** Tampering is informational only. Future sprint can
  decide whether to upgrade to auto-veto (with override).
- **No qualifying-question loop.** Level 5's "synchronous question/
  answer interaction loop" was deferred to v0.2.
- **No alerting/persistence hooks.** The flag lives in the result
  object only. Future sprint can wire to Supabase or Slack.
- **No tampering-class taxonomy.** v0.1 reports a single boolean +
  similarity. Future sprints can break out the four causes above as
  separate fields.

---

## Calibration

The 0.99 boundary for `too-tight` is initial. The federated learning
loop (v0.2-0.3) will refine it from production data:

- If too-tight fires too often on legitimate factual lookups → raise
  the threshold (e.g. 0.995).
- If too-tight misses obvious memorization on novel claims → lower it
  (e.g. 0.97).

The Pythagorean Comma constant itself (`531441/524288 ≈ 1.013643`,
`HAL_PYTHAGOREAN_COMMA` in `src/hal/lib/constants.ts`) is fixed and
patent-load-bearing — never modify. The zone boundaries calibrate
around it.

---

## Patent-portfolio note

The tampering signal is an application of P-003 (Pythagorean Comma BFT)
in the inverse direction: where the original BFT critical-veto fires
on tight agreement that exceeds the ratio (suspecting fabricated
consensus), the tampering flag at level 5 fires on tight agreement
*below* the ratio (suspecting memorization or coordination). Both
mechanisms protect against different consensus-collapse failure modes.
