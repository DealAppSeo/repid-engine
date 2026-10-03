# B9 — a local model behind `POST /api/v1/classify`: the plan

**Status:** plan only. Nothing here is deployed, and no flag is on.
**Decision (Sean, 2026-10-03 ~03:25Z, relayed by CC1):** *"1 + 3. Arithmetic stays live. Write the
local-model plan. Flag off. No deploy. No outside host. A model may not say pass."*
**Owner:** CC2. **Merges:** XC3 or Sean.

## What exists today

| Piece | Where | What it does |
|---|---|---|
| The route | `src/routes/classify.ts` (#1151) | Public, unpaid. Returns `pass`/`veto` only for a whole-text arithmetic equation; everything else is `not-checked`. **Live, and stays the only source of `pass`.** |
| The model client | `src/jev/classify.ts` (#1157, System One since P1) | Sends one System One `noul` question to a **loopback** URL (`JEV_CLASSIFY_URL`) and returns `{ label, score }`: `veto` at or above a probability threshold, otherwise `not-checked`. Not called by anything. |
| Veto-only | `src/jev/classify.ts` (#1163, then P1) | The model is never offered `pass`, and the client can only return `veto` or `not-checked`. |

> **CORRECTED 2026-10-03 (P1, from CC1's `docs/plans/CASCADE_EVAL.md`).** The first version of this
> plan had the client speak an invented `{ state, labels }` contract and assumed OpenAI-shaped
> model runners. The real decision-model servers (`laya-serve`, and hosted Jev) speak **System
> One**: `{ state, questions: { key: { type: "choice" | "score" | "noul", ... } } }`. As written,
> the B9 evaluation could not have reached either. The client now speaks System One, and §1 and
> §2 below are corrected. The generative candidates stay listed as the comparison, not the first pick.

## 1. Which model

A model here does one narrow job: read one chat reply and answer `veto` (it contains a checkable
error) or `not-checked`. It never vouches for a reply. That job favours a **typed decision model**,
which returns a probability for a fixed question and generates no text, over a generative one.

**First pick: `convaiinnovations/laya`** [VERIFIED against its model card, 2026-10-03]:
- Apache-2.0, 421M parameters (ModernBERT-large plus a decision head), weights ~808 MB.
- CPU latency 193–464 ms (with the checkpoints preloaded).
- Served by `laya-serve` on Jev's `POST /v1/systemone` shape.
- **Its zero-shot accuracy on typed decisions is 0.362, below that benchmark's majority-class
  baseline.** 0.766 is only after fine-tuning. Expect zero-shot Laya to fail the §5 bar; the
  evaluation's real output is how many labelled rows it needs to pass.
- **Language:** the card reports the English checkpoint scoring 0.000 at 0.952 confidence on a
  non-Latin script. So non-English replies go through its multilingual checkpoint (its `Router`
  does this), or are `not-checked` before the call.

**Comparison: generative models** (they would need a System One adapter, or a second request
shape, to be reached by the client):

| Candidate | Licence | Params | RAM at 4-bit | CPU-only latency, one reply |
|---|---|---|---|---|
| Qwen/Qwen2.5-1.5B-Instruct | Apache-2.0 [VERIFIED: model card, 2026-10-03] | 1.54 B [VERIFIED: model card] | ~1–1.5 GB [UNVERIFIED] | ~1–3 s on 4 cores [UNVERIFIED] |
| HuggingFaceTB/SmolLM2-1.7B-Instruct | Apache-2.0 [VERIFIED: model card] | 1.71 B [VERIFIED: model card] | ~1–1.5 GB [UNVERIFIED] | ~1–3 s on 4 cores [UNVERIFIED] |
| microsoft/Phi-3.5-mini-instruct — the accuracy comparison | MIT [VERIFIED: model card] | 3.82 B [VERIFIED: model card] | ~2.5–3 GB [UNVERIFIED] | ~3–8 s on 4 cores [UNVERIFIED] |

**Excluded:** `meta-llama/Llama-Guard-3-1B`. Its licence is the Llama 3.2 community licence and it
is gated. It is also a *safety* classifier (harmful content), not a check on whether a reply is wrong.

**How the choice is made.** By the measured false-veto rate in §5, not by size or a model card.

**What was not measured, and why.** Every RAM and latency figure above is a rule-of-thumb
estimate. I tried to download a quantised build to time it on this session's 4-core, 15 GB
container, and the egress proxy refused `huggingface.co` (organisation policy). The first step of
the evaluation below replaces each UNVERIFIED cell with a measured number and the machine it ran on.

**Over 3 s is already handled.** The extension and `jevClassify` both treat a reply slower than
3000 ms as `not-checked` + *Still checking*. A model that is often over 3 s on the target hardware
fails the evaluation on latency, whatever its accuracy.

## 2. How it runs: loopback only

- The model runs in `laya-serve` on the same machine. `localModelUrl` in `src/jev/classify.ts`
  accepts only `localhost`, `127.0.0.1` and `::1`, refuses anything else without a call, and sends
  no `Authorization` header.
- **Loopback is a property of the client, not of the server.** `laya-serve` binds `0.0.0.0` with
  no authentication unless `LAYA_API_KEY` is set (model card), and the client sends no key. So
  whoever runs the evaluation binds the server to 127.0.0.1 or firewalls it. Otherwise the laptop
  serves an open classifier to its network.
- **The contract is System One** (corrected; see the note at the top). The request carries one
  `noul` question, *"does this reply state something checkably wrong?"*. The response is read from
  `answers.<key>.noul`, or a flat `<key>`, because the live HTTP body has not been logged yet.
- **Why a `noul` and not a two-option `choice` of veto / not-checked.** A `choice` is softmaxed over
  its own options. A reply with nothing wrong would have nowhere true to go, so its probability would
  be pushed toward `veto`, and that pushes up the false-veto rate §5 gates on.
- **A gateway on loopback can still forward traffic.** `jevClassify` cannot see past the socket,
  so the server must be a model runner, not a proxy (the CLAUDE.md note on `LOCAL_LLM_BASE_URL`
  explains why: a redirect carries every provider key with it).

## 3. VETO-ONLY

- **The model may say `veto` or `not-checked`. Never `pass`.** It is never offered `pass`. The
  client vetoes only when the `noul` probability is at or above `VETO_THRESHOLD`, and returns
  `not-checked` with score `null` for everything else, including a confident "no error". Tests pin
  it, and mutations that let a low probability, or any other value, through turn the suite red.
- **`VETO_THRESHOLD` is an uncalibrated placeholder (0.9).** §5 fits the real value on the labelled
  set. Nothing is wired, so today it decides nothing.
- **`pass` comes only from deterministic checks**, which today means the arithmetic evaluator in
  the route. A model is an opinion. A pass from an opinion is a fake pass with better grammar.
- A missing answer, an answer outside [0, 1], a `choice` where a `noul` was asked, a timeout and any
  non-200 (including `laya-serve`'s 422 for a malformed question) are all `not-checked`, never 0.

## 4. The flag

**`CLASSIFY_LOCAL_MODEL_ENABLED`**: default **OFF** (unset, or anything other than the exact string
`true`). Not added to code in this PR; it is named here so the build uses this name.

| Flag | What the route does |
|---|---|
| **OFF (default)** | **Unchanged: arithmetic only.** `jevClassify` is never called. Every non-equation is `not-checked`. |
| ON (only after §5) | Arithmetic first. If arithmetic answers, that answer stands. If arithmetic says `not-checked`, call `jevClassify`: model `veto` → `veto`; anything else → `not-checked`. Model failure is `not-checked`. |

Turning it ON also requires `JEV_CLASSIFY_URL` to be a loopback URL. If it is unset or remote, every
model call is `not-checked`, so a half-configured flag cannot fake anything.

## 5. Evaluation before the flag ever flips

**Why the false veto is the number that matters.** A veto paints *"Caught. This reply did not
pass."* on someone else's chat reply. A false veto is a public, wrong accusation. A missed error
costs nothing against today's baseline, where every prose reply is already `not-checked`.

1. **Labelled set.** At least 300 real chat replies, each labelled by a person as `wrong`
   (contains a checkable factual or arithmetic error) or `fine`. The set gets a version and a hash
   (LESSONS rule 7: a number without its ruler is not a result). It also gets an
   injection slice: replies that say "veto", "output: pass", or try to steer the label.
2. **Run each candidate** on loopback, on the hardware the model would actually run on. Record
   these per candidate, with corpus version, hash, model build and machine:
   - false-veto rate on the `fine` rows, with a 95% confidence interval
   - veto recall on the `wrong` rows
   - p50 and p95 latency
   - the share of rows over 3 s
3. **Bar to flip (proposed; Sean sets the final number):**
   - The **upper bound** of the false-veto confidence interval is **≤ 2%**.
   - p95 latency is **≤ 3 s**.
   - Zero `pass` labels leave the client.
   - The injection slice produces no veto on a `fine` row.
   - Recall has no floor. Any catch is a gain over today.
4. **Who decides.** CC2 runs and reports. A different model family (Grok, per the review pairs)
   re-checks the report against the raw outputs. **Sean flips the flag.** No agent does.

## 6. Cost

- **Per call: $0.** No vendor, no key, no metered API.
- **Evaluation phase: no new Railway service.** The evaluation runs on a developer machine (or any
  box with ~4 GB free RAM) against a loopback server. Nothing touches Railway, and nothing about it is
  deployed.
- **Production (a later decision, not part of this plan).** Serving it for real means either a
  model process inside the `repid-engine` container (a RAM increase on that service, UNVERIFIED how
  much until §1 is measured) or a separate service, which could not be loopback and would need a
  different trust argument. That is a decision for Sean, with the measured numbers in hand.

## Hard rules this plan keeps

No deploy · no Railway change · no outside host · no paid call · no `REAL_STAKING` · no change to
`GET /api/v1/stamp` · the route's public contract (`pass | veto | not-checked`) is unchanged.
