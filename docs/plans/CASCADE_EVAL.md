# Typed-decision cascade: what to evaluate, what to wire for a later switch

**Status:** plan only. Nothing here is wired, deployed or flagged on.
**Asked by Sean, 2026-10-03:** consider the Grok + ChatGPT "portable intelligence control plane"
memo (Jev, Laya, NIM, OpenShell) for an eval, a future switch, or a performance fold-in.
**Author:** CC1. **Red-team:** XC (Grok). **Decisions:** Sean.

The memo's useful idea is three compute layers, cheapest first:

| Layer | Answer shape | Use |
|---|---|---|
| Deterministic | the code knows | rules, schemas, tests, check runs, DB constraints |
| Judgment | a fixed option set plus a confidence | a typed decision model (Jev, Laya) |
| Generation | new text, code or a plan | an LLM, only when the two above cannot answer |

This file maps that onto what already exists, so nothing is built twice.

## 1. Measured, not assumed [MEASURED 2026-10-03, `llm_call_log`, read-only]

- **30 days of model spend: well under $1, almost all on free tiers.** About one call in five
  had any cost at all.
- Since 2026-09-24 the volume has been a few dozen calls a day, and nearly all of them succeed.
- The 30-day failures are dominated by **two past bursts**:
  - provider rate limits, ending 2026-09-06;
  - a day when credits ran out on two providers and a third rate-limited (2026-09-23).
- HAL fact-check p50 latency is **about 1.1 s**.

Exact counts are left out on purpose: this repo is public (CLAUDE.md, *findings, not
inventories*). The query below reproduces them.

**Consequence.** A cost cascade saves this system almost nothing: it already runs on free
tiers for pennies a month. Inside our own stack, the possible gains are **latency** (skipping a
~1 s quorum) and **resilience** (the 429 and credit-exhaustion bursts above). The money case
belongs to *users'* agents, which run on frontier models. Re-run with:

```sql
select task_hint, status, count(*), round(sum(coalesce(cost_usd,0))::numeric,4)
from llm_call_log where created_at > now() - interval '30 days' group by 1,2 order by 3 desc;
```

## 2. What already exists, per layer

| Layer | Already here | Gap |
|---|---|---|
| Deterministic | `POST /api/v1/classify` (arithmetic, the only source of `pass`) · Receipts (trustshell: claims checked against check runs, no model) · `x402-gate` · trustshell `auditThenAct`, `wrapExecute` | Deterministic answers are not counted anywhere, so "handled without a model" has no number |
| Judgment | `src/hal/jev-prefilter.ts` (Jev via OpenRouter System One, flag `HAL_JEV_PREFILTER_ENABLED`, **off**) · `src/jev/classify.ts` (loopback client, veto-only, **unwired**) | See 2a and 2b |
| Generation | `routeRequest` in `src/providers/router.ts` (free-first, SLM tier, paid tail by cost) · HAL quorum | No single choke point: HAL and the provider adapters call `fetch` directly |
| Ledger | `GET /api/v1/costs/summary` (24 h, by provider and task) | No plain sentence a non-engineer can read |

### 2a. "Laya" in this repo is not the Laya model

`src/laya/classify.ts` and `/api/v1/laya/classify` route by **keyword and length**: a question
asks; text over 280 characters, or naming an attestation, proof, quorum, stake or contract,
escalates. It calls no model. The Convai Laya model is wired **nowhere**. The name is a label,
not evidence (LESSONS rule 4). Anyone reading "Laya is live" off the route name would be wrong.

### 2b. The loopback client speaks the wrong contract

`src/jev/classify.ts` sends `{ state, labels }` and reads `{ label, score }`. That shape is ours.
Both real Jev and the real Laya server (`laya-serve`) speak the **System One** shape:

```
request:  { model, state, questions: { <key>: { type: "choice" | "score" | "noul", instructions, ... } } }
response: one typed answer per key, e.g. { "<key>": { "type": "choice", "choice": "...", "confidence": 0.93 } }
```

The answers may come back nested under an `answers` envelope rather than at the root. Laya's
Python API returns `result["answers"][key]`, and the HTTP body is NOT CHECKED. `jev-prefilter`'s
reader already accepts `answers`, `questions`, `results` or the root for this reason.

So today, pointing the client at `laya-serve` on loopback could not work. Fixing that one
contract makes local Laya and hosted Jev **the same call**, and the switch between them becomes a
URL.

## 3. External facts [VERIFIED 2026-10-03 against primary pages]

- **Jev (TypeSafe), 2026-09-15.**
  - $0.042 per million input tokens; output is not billed; early access.
  - Question types are `choice`, `score` and `noul`. **"noul" is not "null".**
  - Hosted only: no self-host option was found.
  - OpenRouter benchmark (2026-09-22), on **Banking77 only** (77 intents, 3,080 utterances):
    - Jev 81.0% vs Opus 5 84.4%; p50 175 ms vs 2,266 ms.
    - With a 0.90 threshold, 75.9% of traffic stays on Jev, accuracy drops 0.4 points and cost
      falls 3.5×.
  - **The post's own caveats:** the cascade figures used the same test set, so they are an upper
    bound, and the confidence is *not calibrated*.
- **Laya (Convai Innovations), around 2026-09-18.**
  - Apache-2.0, 421M parameters (ModernBERT-large plus a decision head).
  - `laya-serve` speaks Jev's `/v1/systemone` shape, with **no auth unless its own API-key variable is set**.
  - CPU latency is 193–464 ms; ONNX is an official extra; weights are ~808 MB.
  - **Zero-shot accuracy is 0.362**; 0.766 only after fine-tuning on their own split.
  - Banking77: 42.5%, against Jev 87% on 72 labels (not like-for-like).
- **NVIDIA OpenShell, 2026-09-28.**
  - Apache-2.0, 0.1.x; a sandbox with a **YAML** policy (not Cedar, not Rego), and policy changes
    checked by a prover.
  - Sentry is a BlueField-4 reference design, not software we could use.
- **WASI 0.3.0, 2026-06-11.** Native async, stream and future. Not a reason to change anything now.

## 4. Proposals, in order. All are flag-off and unwired until Sean says GO

### P1 (now; $0; no outside host). One System One client

Make `src/jev/classify.ts` speak the real System One contract, and keep everything it guarantees
today:

- loopback-only, no `Authorization` header;
- veto-only (`pass` → `not-checked`);
- `not-checked` on a timeout, non-200 or bad body;
- stores nothing.

The question is **one `noul`**: *"Does this reply contain a checkable factual or arithmetic
error?"* The client vetoes only when the probability is at or above a threshold set from the
labelled set. Every other outcome is `not-checked`.

It is not a two-option `choice` such as `veto` / `not-checked`. Laya takes a softmax over a
question's options, so a fine reply would have nowhere true to go, and that inflates the
false-veto rate, which is the one number B9 gates on (CC2). The model is never offered `pass`, and
the client still coerces `pass` to `not-checked`.

The reader accepts both the root and the `answers` envelope, with a test for each. The first
real `laya-serve` body gets logged and pinned. Tests run against a fake loopback server.
**Still unwired.**

**Loopback-only is a property of the client, not the server.** `laya-serve` binds `0.0.0.0` with
no auth by default, so the evaluation's run steps must bind it to `127.0.0.1` explicitly, or put
it behind a firewall. The
B9 evaluation can then run real `laya-serve` on loopback, and hosted Jev later uses the same
contract.

Owner: **CC2** (owns B9; it also corrects the contract in `B9_LOCAL_MODEL.md`).

### P2 (eval; $0; runs on a laptop). Laya on the B9 veto task

The B9 plan already sets the bar: an upper false-veto CI bound ≤ 2%, p95 ≤ 3 s, and an
injection slice. **Expect zero-shot Laya to fail** (0.362). So the evaluation's real output is
the **number of labelled rows Laya needs to pass the bar** after fine-tuning: run it at 100, 300
and 1,000 labels. The English checkpoint collapses on non-Latin scripts at high confidence, so
there are two options: run through Laya's multilingual `Router`, or mark non-Latin text
`not-checked` before the call. Either way, the labelled set needs a non-English slice.
**Blocked on the labelled set, which does not exist yet.**

### P3 (eval; about $0.01; needs Sean's GO because it is a paid call). Jev as a shadow prefilter

Run `jev-prefilter` in **shadow** over a frozen, hashed corpus of HAL inputs. Shadow means it
records "would skip" and HAL always runs. Report:

- the would-skip rate;
- agreement with HAL's verdict;
- the latency HAL would have saved.

Live HAL inputs are not stored, so the corpus has to be built, and it has to be built from
**text that is fine to leave the box**: this call goes to OpenRouter, and `jev-prefilter` asserts
the egress boundary.

Cost: 300 items × ~500 input tokens = 150k tokens ≈ **$0.006**.

### P4 (now; $0). The sentence

Extend `GET /api/v1/costs/summary` with one plain line built from the fields it already reads,
for example: *"30 days: N model calls, M on free tiers, $X."* Deterministic
answers (`/classify` arithmetic, Receipts) are not logged, so the line must **not** claim "handled
without a model" until they are counted. A number with no counter behind it is the
fake-measurement defect.

### Next: the seatbelt in front of one external coding agent

Use trustshell's `auditThenAct`, `wrapExecute` and `action-envelope`. Read OpenShell's YAML policy
as the competitive artifact. Map it; do not wrap BlueField. Vendor-neutral is the wedge.

### Later

Private mode, selective proofs, WASI capabilities, and x402 routed by RepID task-class stats.
RepID only routes once it carries task-class numbers (n, success rate, median cost, latency),
not stars.

## 5. Rules this plan keeps

- No deploy, no Railway change, no new service.
- No paid call without Sean's GO (P3 is the only paid item, ~$0.006).
- No outside host for the local path; no Anthropic call.
- **A model may not say `pass`.**
- Low confidence escalates; it never guesses.
- One client, one receipt path, one ledger. No second router.
