# Three questions, measured — and where I'd revise both Grok and myself

**All numbers below read live from production on 2026-08-11.** Where I disagree with Grok or
with my own earlier note, the disagreement is because something got measured in between.

---

## 1. The just-culture asymmetry: I was wrong, and the truth is worse

**My hypothesis:** self-reported failure probably costs the same as a detected failure, so
agents are incentivised to conceal.

**Measured:** there is no self-report path *at all*. Across **152,130** score events, all
**eight** negative event types are detection-shaped:

| event_type | n | avg Δ | who caused the entry |
|---|---|---|---|
| `VALIDATION_FAILED` | 26 | −101.08 | a validator |
| `EPISTEMIC_VIOLATION` | 2 | −60.00 | a detector |
| `CHALLENGE_LOSS` | 15 | −31.53 | a challenger |
| `VALIDATOR_PENALTY` | 1 | −5.00 | a validator |
| `HAL_SCORE_EVENT` | 147,711 | −4.63 | HAL |
| `DORMANCY_DECAY` | 2 | −3.00 | the clock |

An agent that *wants* to disclose its own error has no channel. The only way a failure enters
the ledger is if something else catches it. So the expected cost of concealment is not merely
*equal* to disclosure — disclosure has no representation, which makes concealment strictly
dominant by construction rather than by policy.

### And then the twist: it was built, and it is inert

```
repid_confession_log                      → 0 rows,  no writer anywhere in src/ or scripts/
repid_credentials.voluntary_disclosure    → 0 rows true,  no reader, no writer
repid_adversarial_immunity
  .false_confessions_flagged              → column exists (table has 58 rows)
```

Someone designed this properly. They anticipated confessions, voluntary disclosure, *and* the
abuse case of **false** confessions — that is a sophisticated threat model. Then nothing was
wired to it.

This is **LESSONS #3, exactly**: *an unwired mechanism is worse than an absent one — it
converts a known gap into false coverage, so you stop looking.* A reviewer reading the schema
would reasonably conclude just-culture is handled. It is not. It is a table with zero rows
and no caller.

**So the fix is not a design. It is wiring**, which is much cheaper than Grok or I assumed:

1. Add `SELF_REPORTED_FAILURE` to the event vocabulary with a delta strictly smaller in
   magnitude than its detected counterpart.
2. Write to `repid_confession_log` on that path.
3. Add the fence: a test asserting the self-reported delta is strictly cheaper than the
   detected one **for the same underlying failure class**. Without that test, the asymmetry
   will drift back to parity the first time someone "normalises" the deltas.
4. Guard the abuse case the original designer already anticipated: a confession to something
   that never happened is cheap reputation laundering. `false_confessions_flagged` is the
   hook; it needs a rule.

---

## 2. A second-order finding neither of us looked for

**99.86% of all negative reputation events come from a single detector.**

```
negative events total            68,417
   of which HAL_SCORE_EVENT      68,321   (99.86%)
distinct negative event types         8   (7 of them are rounding error)
```

Task **#56** records that 3 of ~6 HAL providers are down (402 credits, 401 bad key). So the
sole source of punitive signal is degraded right now.

The dangerous part is not the outage. It is that **a detector outage and a genuine
improvement in agent behaviour produce the identical signature**: fewer negative events. The
reputation system cannot distinguish "agents got better" from "the thing that notices stopped
noticing."

This is LESSONS #8 — a measurement without its ruler — applied to reputation rather than to
HAL's F1. The fix is cheap and belongs with the just-culture work: record detector liveness
alongside the score, so a score movement can always be divided by the coverage that produced
it. A score computed under 3-of-6 providers is not comparable to one computed under 6-of-6,
and nothing currently records which regime a given event came from.

---

## 3. Dual-auth binding: it is neither of the two options we debated

Grok framed it as session-binding vs content-hash binding and recommended content-hash. I
agreed. **Both of us were choosing from the wrong menu.**

`src/services/dual-auth-gate.ts` binds human authority to `user_standards_hash` — the
*owner's standards*, committed inside the proof and compared against `boundStandardsHash`:

```ts
} else if (st.user_standards_hash !== bound) {   // policy binding, not action binding
```

That is a **third option: policy-binding.** Its threat profile is genuinely different:

- **Stronger than session-binding.** The policy is committed *inside the proof*, so an
  attacker cannot swap policies or ride an authenticated session with a different one.
- **Weaker than content-hash binding, and confused-deputy is exactly the gap it leaves.** A
  compromised agent acting *within* the owner's standards is authorised. The gate says ALLOW,
  correctly, because the owner did permit that class of action. The deputy is not
  impersonating anyone — it is exercising real authority that has been re-aimed.

So the question is not "is it bound" but **"how tight are the standards?"** If they say
"may spend ≤ $10 on data services", a confused deputy spends $10 on the attacker's chosen
data service and every check passes.

One more thing worth flagging: in the harness, `boundStandardsHash` is
`leaf hash 4444 5555` — two placeholder constants. There is no real standards document being
hashed yet. The mechanism is correct; the content is a stub.

**Revised recommendation, replacing both of ours:** keep policy-binding — it is the right
primitive for standing authority, which agents need. Add content-hash binding **as a second
tier for actions above a value threshold**, mirroring the existing `PAYMENT_PROOF_REQUIRED_ABOVE`
pattern already in `outcome-classification.ts`. Small in-policy actions stay frictionless;
large ones require the human to have authorised *that payload*. Requiring content-hash on
everything would destroy the autonomy that makes the system worth having.

---

## 4. Where I'd revise Grok's OPRF section

The mechanics are correct. Three refinements.

### 4.1 The three protections are distinct, and only two of them exist

Grok's framing blurs what OPRF and epoch rotation each buy. Precisely:

| Threat | Defended by | Present? |
|---|---|---|
| A node holding the index enumerates the tag space offline (`tag = OPRF(tier)` for all 3 tiers) | distributed OPRF | yes |
| Linking the same predicate across time | epoch rotation | yes |
| **Frequency analysis of tags within one epoch** | **nothing** | **no** |

With `tier` at three values, an observer sees three tag buckets in an epoch and ranks them by
frequency. The OPRF does not help — it never touched the *distribution*, only the mapping.

**This is the same finding as E1, one layer up.** Moving low-entropy predicates behind an
OPRF does not raise their entropy. Either accept the within-epoch leak explicitly (it may
well be fine — that is what "coarse tag" is supposed to mean), or tag on a *conjunction*
(`tier × domain × time-bucket`) so the domain is large enough for the frequency profile to
stop being a fingerprint. Silently hoping the OPRF covers it is the failure mode.

### 4.2 Update tokens and forward-unlinkability are in direct conflict

Grok offers Option A (update token Δ, rewrite tags offline) and Option B (hard epoch cut) as
alternatives without noting the tradeoff. They are not interchangeable:

**If Δ exists, anyone who ever holds Δ can link across the epoch boundary** — which destroys
precisely the unlinkability the rotation was performed to obtain. You can have cheap
historical rewriting *or* forward-unlinkability. Not both.

That makes it a policy decision, not an implementation detail:
- searchable history matters more → update tokens, and be honest that rotation is
  key-hygiene only, not unlinkability;
- unlinkability matters more → hard cut, and accept that historical search is epoch-scoped.

I would take the hard cut, because epoch-scoped search is a mild inconvenience and false
unlinkability is a security claim you would end up making in public.

### 4.3 The proposed snippet has a real bug worth naming

```rust
fn update_tag(old_tag: &[u8; 32], delta: &[u8]) -> [u8; 32] {
    poseidon2_hash(&[old_tag.as_slice(), delta].concat())   // ← breaks the OPRF invariant
}
```

Hashing `(old_tag ‖ Δ)` does not produce `OPRF_{k'}(x)`. It produces an unrelated value, so
the rewritten tag no longer matches what a client computes by evaluating the new key — search
silently returns nothing. A real update token is a *group operation in the OPRF's own
algebra* (typically `tag^Δ` in the prime-order group), not a hash. The comment says
"scheme-specific", which is the right instinct; the code then picks the one option that
cannot work.

---

## 5. Where I'd revise the GraphRAG / DAG-GNN recommendation — measured

> **PARTIAL RETRACTION, same day.** Item 1 in the "revised recommendation" below — "five
> orders of magnitude more edge material" from 152,130 score events — is **wrong**. It
> reasoned from row counts without reading the schema. `repid_score_events` has no
> counterparty column; all 152,130 events yield **42 unique agent pairs**, and
> `service_contracts` / `x402_settlements` are strict subsets that add none. Taken literally
> it would have written ~267,000 degree-1 pendants and made the degree problem worse. The
> diagnosis in this section (you do not have a graph; build it before the GNN) survives; the
> proposed *source* of edges does not. See `GRAPH_BACKFILL_MEASURED.md` for the measurements
> and for what was built and applied instead.

Grok cites "+10–20 points", "~80% more truthful", "2× more questions answered". I cannot
verify those and would not put them in a design doc as fact; they read like vendor benchmark
figures, and GraphRAG results are notoriously corpus-dependent.

But the decisive objection is not the citations. **You do not have a graph yet:**

```
agent_memory_nodes    241
agent_memory_edges    154
hyperdag_nodes          0
dag_nodes               1
graph_rag_edge_inference_metrics   3
```

154 edges across 241 nodes is **average degree 1.28**. That is not a graph with multi-hop
structure; it is mostly isolated nodes with a few pendants. Multi-hop retrieval has almost
nothing to traverse, and a GNN trained on it will learn noise — 154 edges is fewer than the
parameter count of the single `Linear` layer in Grok's own snippet.

For contrast, from the 2026-08-10 handoff: CodeGraph indexed this repo into **11,043 nodes /
44,077 edges in 17.4 seconds**. The Graph-RAG store accumulated 241 nodes in eight months.

**Revised recommendation: build the graph before the GNN.** The bottleneck is edge creation,
not ranking. Concretely, and in this order:

1. Backfill edges from data you already have and are not using as a graph — 152,130 score
   events, 1,307 fulfilled services, 403 settlements, 194 contracts all carry
   agent→agent and agent→artefact relations. That is five orders of magnitude more edge
   material than the 154 you have.
2. Measure whether multi-hop retrieval beats single-hop **on your own corpus** before
   adopting anyone's benchmark numbers.
3. Only then consider a GNN, and only if step 2 shows structure worth learning.

A GNN on degree-1.28 is the same category of error as searchable encryption on a 3-value
column: applying a sophisticated technique to data that lacks the property the technique
exploits.

---

## 6. Revised priority

Grok's ordering is close to right. Mine, after measuring:

1. **Wire the confession path.** Not design it — it exists. Add the event type, the writer,
   the strict-inequality fence, and the false-confession rule. Highest leverage because it is
   nearly free and it changes agent incentives permanently.
2. **Record detector coverage alongside every score event.** Without it, HAL's current 3-of-6
   degradation is silently rewriting reputation history, and no one can tell later.
3. **Decide the dual-auth tier threshold** — policy-binding below it, content-hash above it.
4. **Document the E1 kill with the entropy table** so the PEKS path is not reopened. *(done —
   `MESH_DATA_SHARING_BRAINSTORM.md` §7)*
5. Negative-space fields on the wire, with one consumer that actually branches on them.
6. Backfill the memory graph from existing relational data. Defer the GNN entirely.

Items 1 and 2 are both small, both measurable, and both fix things that are actively wrong
today rather than adding capability.

---

*Every number here is from a live query on 2026-08-11 and can be re-run. The critique of
Grok's snippets is a code reading, not a measurement, and should be checked against the
actual scheme chosen.*
