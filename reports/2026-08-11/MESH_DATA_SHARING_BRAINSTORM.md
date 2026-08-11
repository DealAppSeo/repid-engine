# How agents should share data — a brainstorm to argue with

**Status:** mostly speculation, deliberately. §7 is measured against live production tables and
kills one of the options outright. Every claim that could be
tested has a proposed experiment attached, because the point is to find out, not to decide.

---

## 0. The one contrarian claim, up front

**The cryptography is not the moat. The honesty machinery is.**

Within eighteen months every serious agent framework will ship ZK attestation. Proof systems
commoditise; they always do. What almost nobody builds is a system that reliably reports
*what it could not verify*.

Today, in this repo, the trust harness refused to pass a gate because HAL was rate-limited.
The demo printed four named gaps instead of a green tick. A fold reported `weighted_update`
as vacuous rather than letting a verified-but-meaningless root through. That behaviour is
rarer and harder to copy than a Plonky3 circuit.

**Design implication:** make negative space a first-class field in the packet format. Every
packet carries not only what it attests but what it explicitly does *not*:

```
attests:      { agent_bound, score_gt_threshold }
does_not_attest: [ freshness, provider_availability, human_authority ]
unknown_because: [ "HAL 429 at 2026-08-11T04:02Z" ]
```

A consumer can then reason about coverage instead of assuming it. This is the thing to put in
the spec before anything else, because it is the thing competitors will not think to copy.

---

## 1. The fastest secure sharing is not sharing

Most mesh coordination does not need the data. It needs an answer about the data:

| Question | What actually has to move |
|---|---|
| Is this agent above threshold? | a range proof (~10 KB, already built) |
| Have I dealt with this agent before? | a scoped nullifier (32 bytes) |
| Did this exchange happen as claimed? | a receipt hash + anchor pointer |
| What is the aggregate reputation? | a fold root (32 bytes) |
| Do we share any counterparties? | a PSI transcript, no lists |

**The mesh should gossip roots and manifests, not records.** Fetch the body only on dispute.
This is roughly how git achieves its speed: content-addressed blobs, a tiny signed manifest,
verification by hash, transfer only what is missing.

The corollary worth testing: if the common path never moves a payload, then payload
encryption stops being on the hot path, and you can afford something much stronger than you
could if every read had to decrypt.

---

## 2. Searchable encryption — the honest version

This is where I would push back hardest on the current framing.

Practical schemes leak, and the leak is usually worse than expected:

- **Deterministic encryption** — fast equality, leaks frequency. On low-entropy fields
  (tier, verdict, status, price buckets) frequency analysis re-identifies most rows.
- **Order-preserving / ORE** — leaks order, which on numeric fields is close to leaking value.
- **SSE with an encrypted index** — better, but leaks *access patterns*, and access patterns
  over a commerce graph are the business graph.
- **PIR** — hides access pattern, costs orders of magnitude more.
- **OPRF** — genuinely practical: "do you hold this key" without revealing the key.
- **PSI** — "which counterparties do we share" without revealing either list.

**The pragmatic architecture: do not search the secret. Search a tag you deliberately chose
to be disclosable.** Split every record into

- a **sealed body** (never searched, strong AEAD, opened only by the counterparty or on
  dispute), and
- a small set of **coarse tags** designed so that leaking the tag distribution is acceptable.

Derive tags with a **distributed OPRF** so no single node can dictionary-attack the tag space,
and rotate the OPRF key on an epoch so historical tags stop being linkable forward.

The design question to answer empirically is not "which scheme" but **"what is our leakage
budget"** — and that is measurable on data already in the database.

---

## 3. What to steal from outside tech

Six that map unusually well.

### 3.1 Aviation "just culture" / NASA ASRS — the reputation design flaw

The Aviation Safety Reporting System gets truthful incident data by granting limited immunity
for *self-reported* errors. Reports go to NASA, not the regulator. Just culture distinguishes
**error** (honest mistake, system fixes it) from **at-risk behaviour** (coach) from
**recklessness** (punish).

**The sharp implication for RepID:** if self-reporting a failure lowers an agent's score by
the same amount as a *detected* failure, rational agents hide failures. You will have built a
reputation system that systematically destroys the data it most needs.

The fix is asymmetry: a self-reported failure should cost strictly less than the same failure
caught by a counterparty or an auditor. That single asymmetry turns concealment into a
losing strategy without needing to detect concealment.

I would check whether the current `repid_score_events` deltas already have this property.
My guess is they do not, because almost nobody builds it in deliberately.

### 3.2 IAEA safeguards — a discrepancy budget, not binary trust

Nuclear material accounting does not assume declarations are true and does not assume they
are false. It measures, reconciles, and computes **Material Unaccounted For**, then alarms
when MUF exceeds a *statistically derived* threshold. Small discrepancies are expected;
that is what measurement means.

Applied: the mesh should carry an explicit reconciliation error band between an agent's local
view and the global fold. Alarm on excursion beyond the band, not on any difference at all.
Today the fold is treated as exact, which means the first legitimate rounding difference will
look like fraud, and the tenth will be ignored as noise.

Also from IAEA: **containment + surveillance + accounting are three independent layers**, and
the system is designed so defeating one is insufficient. Compare: proof + anchor + receipt.

### 3.3 Letters of credit and bills of lading — endorsement as reputation

Trade finance solved "two strangers transact across an ocean" in the 14th century. The
mechanism: a *transferable document* whose chain of endorsements is itself the trust signal.
The document is the asset; each endorsement is a party staking their name.

Applied: a receipt that accumulates counter-signatures becomes more valuable than one that
does not, and reputation can be computed **from the endorsement graph** rather than from a
central score. This also gives a natural answer to provenance: the endorsement chain *is* the
provenance, and it is verifiable without a registry.

### 3.4 HACCP (food safety) — instrument the control points, not the product

HACCP's insight is that you cannot test safety into a product at the end. You identify the
few points where contamination can *enter*, and you monitor exactly those, continuously.

Applied to a mesh: do not try to verify every packet. Enumerate the small number of places
where trust can actually be subverted — proof minting, statement construction, fold input,
identity resolution, settlement authorisation — and put a fence at each. This is precisely
the pattern that found every real bug in today's session, generalised.

### 3.5 DP-3T / contact tracing — private encounter matching

Exactly the mesh problem: "have these two ever interacted" without a global graph. Rotating
ephemeral identifiers, local matching, no central linkage. Worth studying for the "verified
instance provenance" requirement, because it is the same shape and it has been through real
adversarial review at national scale.

### 3.6 Compartments and BIGOT lists — layer-specific visibility

Military compartmentalisation is not just ACLs. Three properties worth copying:

1. Compartments are **named**, so you can say what someone is cleared for.
2. Membership is **auditable** — the list exists and is reviewed.
3. Cross-compartment flow requires an **explicit act** that is itself logged.

Compare clinical-trial unblinding: a DSMB can see unblinded data, but unblinding is an
*event*, recorded, with a reason. The lesson is not "restrict access" — it is **make the act
of widening access a first-class, recorded event**. Most systems log reads; almost none log
the decision to grant.

---

## 4. The failure mode I would design against first

**The confused deputy.** An agent acting on behalf of a principal is handed a capability and
tricked into using it for someone else's benefit. This is *the* structural vulnerability of
agentic commerce, and it is not solved by better encryption — it is an authority problem.

Two things help:

- **Capabilities over ACLs.** A capability names the authority *and* the object together, so
  it cannot be re-aimed. An ACL check asks "may this identity do X", which is exactly the
  question a confused deputy answers wrongly.
- **Dual-auth as a defence against re-aiming**, not just a second signature. The point of
  requiring agent authority AND human authority is that the human authority is bound to a
  *specific* action, so a stolen agent capability cannot be pointed at a different one.

Worth checking whether the current dual-auth binds the human authority to the action's
content hash or merely to the session. If the latter, it is a second lock on the same door.

---

## 5. Experiments — cheap, falsifiable, mostly on data you already have

Ordered by information gained per hour spent.

**E1 — Leakage measurement on the real corpus.** *(RUN — see §7. Result: decisive.)*

**E2 — Just-culture A/B on historical events.**
Replay `repid_score_events` under two scoring rules: self-reported failure penalised equally
vs. penalised less. Measure how many historical events were self-reported. If the current
rule already discourages self-reporting, that shows up as a suspicious absence of
self-reports relative to detected ones.

**E3 — Reconciliation band.**
Compute the actual divergence between per-agent local score and the folded root over history.
Derive the statistical band. This tells you whether the fold reconciles at all today — a
question I do not think has been asked.

**E4 — The efficiency curve.**
Measure bytes and latency for three sharing modes on real data: full records; signed manifest
+ fetch-on-demand; proof-only. You have real numbers to plug in (10,673-byte proofs, 52 real
settlements). Produces the actual curve instead of an intuition about it.

**E5 — Access-pattern leakage on the live receipt endpoint.**
The public receipt endpoint already exists. Simulate an adversary who only observes the
*sequence* of receipt lookups. How much of the commerce graph can they reconstruct? Cheap,
and it tests the thing SSE advocates usually wave away.

**E6 — PSI prototype.**
Two agents determine shared counterparties without revealing their lists. Small, well-trodden,
and it either fits the latency budget or it does not.

**E7 — Negative-space packet format.**
Extend one existing packet with `does_not_attest` and `unknown_because`. Then check whether
any downstream consumer actually changes behaviour based on it. If nothing consumes it, it is
decoration — the LESSONS #3 test applied to a data format.

---

## 6. What I would build first

The **sealed-body / coarse-tag split** — because E1 has now been run, and it removes the
other option.

---

## 7. E1, actually measured (2026-08-11, live production tables)

Deterministic encryption preserves the plaintext distribution exactly. So a field's domain
size is an upper bound on its resistance to frequency analysis — no key recovery required,
and no cryptanalysis: you sort ciphertexts by frequency and read off the mapping.

| Field | Rows | Distinct | Max entropy |
|---|---|---|---|
| `repid_zkp_proofs.scheme` | 79,062 | **2** | 1.00 bit |
| `x402_settlements.status` | 403 | **2** | 1.00 bit |
| `repid_agents.tier` | 175 | **3** | 1.58 bits |
| `service_contracts.status` | 194 | 6 | 2.58 bits |
| `x402_settlements.amount` | 403 | **7** | 2.81 bits |
| `repid_score_events.event_type` | 152,130 | 16 | 4.00 bits |
| `repid_agents.agent_name` | 175 | 145 | ~7.2 bits, near-unique |

**Every field worth searching has four bits of entropy or fewer.** Deterministic or
order-preserving encryption over this corpus is decorative: an adversary who knows the domain
— and the domain is *published in the public API*, tier names and all — recovers the mapping
in a single pass over the ciphertexts. 79,062 proof rows across two scheme values is not a
search index, it is a coin flip with extra steps.

Two details worth pausing on:

- **`amount` has seven distinct values across 403 settlements.** "Price" intuitively feels
  high-entropy and here it is a seven-way category. Any scheme reasoning about numeric
  columns as if they were continuous is reasoning about a different dataset.
- **`agent_name` fails the opposite way.** At 145 distinct over 175 rows it is near-unique, so
  deterministic encryption does not leak the *value* by frequency — it leaks a stable
  pseudonym that links every appearance of that agent across every table it touches. Low
  entropy leaks content; high entropy leaks linkage. There is no cardinality that is safe.

**Conclusion: do not encrypt these fields and search them. Do not look for a better scheme.**
The corpus does not have the entropy to hide anything in these columns, and no cipher creates
entropy that the plaintext lacks. Put the sensitive content in the sealed body, and expose
only tags chosen on the explicit understanding that their distribution is public.

The honest silver lining: this is a *cheaper* architecture than the one it replaces, and it
was one query away the whole time.

---

*All of the above is [ASSUMED] unless a number is attached. The outside-tech analogies are
offered as design pressure, not as authority — every one of them has failure modes in its own
domain that are worth reading about before borrowing the pattern.*
