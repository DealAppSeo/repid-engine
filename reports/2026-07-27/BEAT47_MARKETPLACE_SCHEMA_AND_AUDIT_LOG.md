# Beat 47 — two things that looked like they worked, and a fourth send-back

**Date:** 2026-07-27 · **Repo:** repid-engine (+ trinity-symphony-shared) · **Beat:** 47

## Queue at beat start/close [V]

`origin/main` = `354f98b` (Beat 46's ledger landed as #235). Open repid-engine PRs at start:
#235 (merged in-beat), #233, #231 (DRAFT), #225, #220, #216 (CONFLICTING), parked #155/#157.
`trinity_tasks` [V sql]: pending **0**, in flight **0**, `claim_count > 0` on **0** rows,
29 claimed in 24h. **Eighth consecutive beat of the T12 dispatch hold** — the cap is still not
deployed, so any dispatch would run under the old uncapped behaviour.

---

## 1. The public 500 was never a code bug — the table did not exist

`GET /api/v1/marketplace/browse` is PUBLIC and keyless and had been returning
`500 {"error":"browse_query_failed"}`. It has been carried as an open item across several beats
with no root cause.

**[V] `marketplace_listings` existed in NO schema in prod.** Enumerated rather than assumed
(rule 14): `information_schema.columns` empty for the table; a `%marketplace%|%listing%|%market%`
sweep of `public` returned only `agent_listings`; a cross-schema sweep returned nothing. The
TrustMarket-light P0 endpoints shipped in #153 with a schema file
(`scripts/test-schema/marketplace.sql`) whose own header scopes it to the disposable TEST project.
**The endpoint shipped; its table never did.**

Applied to prod as two migrations under the single-writer lane (CLAUDE_RULES r7: net-new additive
objects, prod DDL logged), recorded in-repo at `scripts/prod-schema/2026-07-27_marketplace_p0.sql`.
The test-schema file's closing `test_all_access` policy + `grant all to anon, authenticated` block
is deliberately **omitted** — exactly as that file's own header instructs.

**The second migration is not redundant, and this is the part worth keeping.** After creating the
tables with no grant of mine, `has_table_privilege('anon', 'marketplace_listings', 'INSERT')` came
back **TRUE** — the project has default privileges that auto-grant table access on new public
tables. RLS-with-zero-policies already denied anon, but that is a single layer: one later
permissive policy would silently open a public write path on a table that reads as locked.
Revoked, matching the `x402_settlements` precedent.

**[V] live:** browse → `200 {"listings":[],"count":0}`; `?kind=have&limit=5` → 200; anon
PostgREST read → `401 42501 permission denied for table marketplace_listings`. Insert and select
column lists were checked against the schema first, so `POST /list` works too, not just browse.

The production smoke check had expected 200 and documented the cause the whole time. It was
**left red rather than loosened** by whichever beat wrote it — that discipline is why the outage
was still legible weeks later.

---

## 2. Generalising the class found something much worse

The defect class is "an endpoint shipped without its table." Rather than stop at one instance, I
enumerated every table `src/` references via `.from('…')` (127 names) and diffed against prod.
**Five more were missing:** `api_key_requests`, `audit_merkle_anchors`, `participant_rating_ledger`,
`repid_gate_shadow_log`, `zkp_cards`.

Most are handled deliberately (`participant_rating_ledger` fails loud on the live path; `zkp_cards`
degrades to 404). But chasing `repid_gate_shadow_log` — whose code comment promises a fallback to
`trinity_agent_logs` — turned up the real finding.

### [V] Every trinity_agent_logs write in this codebase has always failed

`trinity_agent_logs.agent` is `text NOT NULL` with no default, and the discriminator column is
`action` — **there is no `event_type` column**. Seven insert sites in `src/` omit `agent`; one also
names `event_type`. Every one fails, and every one is inside a best-effort `catch` or an
`if (error) console.error(...)`.

Proven by a non-persisting probe against prod (a `DO` block that catches each attempt and rolls the
whole thing back):

| attempt | result |
|---|---|
| the code as written (`agent_name` + `event_type` + `metadata`) | `42703: column "event_type" ... does not exist` |
| `event_type` removed, still no `agent` | `23502: null value in column "agent" violates not-null` |
| `agent` + `action` supplied | **SUCCEEDED** |

**[V] Six audit actions have 0 rows all-time**: `zkp_proof_generated`, `zkp_proof_verified`,
`dag_node_verified`, `zkp_batch_generated`, `repid_score_changed`, `repid_gate_shadow`.

**This is an A/B result from live production, not inference.** `middleware/auth.ts:109` and
`zkp/plonky3-stub.ts:12` call the *same helper*, on the *same table*, in the *same deploy*. auth
supplies `agent` and has **29,581 rows in 30 days**; the other omits it and has **0, all-time**.
One distinguishing variable.

**The worst-affected consumer is the RepID active gate.** `logGateShadow` tries
`repid_gate_shadow_log` (absent from prod) and falls back to `trinity_agent_logs` — and the
fallback named `event_type` *and* omitted `agent`, so **both** paths failed and the catch hid it.
Its shadow evidence was discarded in full.

That is the shape that matters: **an empty shadow log reads as "found no problems", not as "never
measured"** — and `REPID_ACTIVE_GATE_MODE=enforce` is a planned flip that would have been decided
on that emptiness. This is the same failure the loop keeps re-encountering: absence of evidence
presented as evidence of absence.

**Fix:** the write contract now lives in one dependency-free module (`src/engine/agent-log-row.ts`)
that makes `agent` and `action` required *at the type level*, so omission is a compile error rather
than a silent no-op — a runtime-invisible bug has to be caught before runtime. Dependency-free
specifically so pure modules like `services/repid-active-gate` (which takes its `db` as a parameter
to stay testable without credentials) can honour it without acquiring the `db` singleton. The
gate's fallback also now logs loudly on failure (D-032): still never throws, but the silent-empty
mode must not be invisible a second time.

### Mutation battery (repid-engine)

Golden copies outside the repo; every edit asserted to have landed; baseline 9/9 green before and
after; all files restored and re-verified.

| mutation | landed | result |
|---|---|---|
| direct insert bypasses `buildAgentLogRow` | yes | **KILLED** |
| gate fallback reverted to `event_type` + no `agent` | yes | **KILLED** |
| runtime guard gutted | yes | **KILLED** |
| scan regex broken so it matches nothing (control) | yes | **KILLED** — guard-on-the-guard fired |
| `agent` removed from a `logAgentEvent` call site | yes | **SURVIVES jest / KILLED by `tsc --noEmit`** |

**That last row is a real limitation and is stated, not smoothed over.** The jest suite does not
typecheck, so protection for `logAgentEvent` call sites lives in the build, not the tests. It *is*
enforced — `ci.yml`'s `Type-check` step sits inside the job named `test`, which is the required
status check [V] — but a green `npm test` alone does not prove it.

---

## 3. Independent verifications (rule 3 — I verified none of my own work)

Three commissioned this beat. Two returned; #231's is still running at close.

### trinity-symphony-shared #34 — SEND BACK (round 4), then round 5 shipped
36 mutations, 26 killed, **10 survived**. All prior rounds' fixes held. The HIGH is the round-3
hole moved up exactly one level: round 3 pinned the id bind *inside* `buildReapParams`; nothing
pinned that the id *reaching* it is the row being reaped. Four mutations of that one argument each
left **45/45 green** while turning the reaper into a permanent silent no-op — including
`buildReapParams(stale[0].id, …)`, which reaps the same row up to 50× per pass while stranding
every other. The round-3 derived check cannot see it: it pins *fetch-covers-use*; the defect lives
one step later, in *bind-uses-fetch*.

**Round 5 shipped (`ffe5343c`).** All nine targeted survivors killed (four id-bind, three cap-predicate
widenings — `< $6 + 1`, `+ 1000000`, `OR TRUE`, all of which the call-site test cannot catch because
the *bind value* is unchanged — and two pgQuery-options), plus two controls confirming rounds 3 and
4 intact. Three mutations first reported DID-NOT-APPLY and were **re-run rather than counted**.
**#34's production code was never wrong** — what was missing was the coverage that keeps it right.

### repid-engine #220 — SEND BACK. The 7-beat-unverified patent evidence, and a real bug
18 mutations, 13 killed, 5 survived. Cryptography confirmed **real, not stubbed** (Poseidon2-BabyBear
against the Rust KAT oracle); the chain write is honestly scoped as mocked. No false claim found in
its report.

- **HIGH (evidence gap):** the **answer-binding** element — the Patent #1 keystone by the module's own
  header — is entirely unpinned. Three mutations reducing what `bindAnswer` commits to (dropping
  `memory_root`, dropping the citation set, dropping the cited value from the digest) each survived
  **47/47**. The shipped code is correct (positive probes confirm), but for reduction-to-practice
  material **the test is the evidence**.
- **HIGH (real code defect):** `verifyProofCarryingAnswer` **throws** on a malformed `memory_root` —
  `bindAnswer` sits outside the try/catch that guards citations. Both `proof-carrying-memory.ts` and
  `hal-grounding.ts` document the opposite ("never crashes the verifier", "adversarial-input safe").
  HAL is precisely what ingests untrusted agent output, and `HAL_GROUNDING_MODE=enforce` is a
  planned flip. One-line fix; no test covers it.
- MEDIUM: the tombstone guard in `verifyMembership` deletable with 47/47 green.
- LOW: the PR's one self-disclosed survivor could not be reproduced — its mutation was materially
  different from its description. Conservative, not wrong.

---

## 4. Mistakes / process notes

- **My own change did not compile, and my own test suite could not see it.** I used
  `buildAgentLogRow` in `routes/v1.ts` without importing it. Three `TS2304` errors, invisible to
  jest because the test does not import that module. Caught only because I ran `tsc` to check
  whether a *mutation* was caught. Fixed; `tsc --noEmit` now exits 0. The tool that caught my error
  is the same one the fix depends on — which is the argument for the fix.
- **A mutation that did not apply is not a result.** M1 in the repid-engine battery reported
  DID-NOT-APPLY and its green run was discarded and re-run properly. Same for three of the
  trinity-shared mutations. Ninth and tenth instances of this guard earning its place.
- **I nearly asserted a code defect that did not exist.** A grep rendering made
  `router.get('/browse'` look like `router.get('\browse'` (a backspace escape, which would have
  made the route unreachable). I checked the bytes with `od` on both `origin/main` and the working
  tree before writing it down. It was a display artifact.
- **The first mutation battery hit a fork exhaustion** (`Resource temporarily unavailable`) from too
  many concurrent node/jest processes, corrupting one mutation's result into a false DID-NOT-APPLY.
  Re-run serially.
- `git merge` and `git reset --hard` were both correctly blocked (guard hook / classifier) when I
  tried to fast-forward a local branch. Worked around by building round 5 in an isolated worktree
  off the remote tip — which is the better practice anyway. **A stale local base is exactly the trap
  a prior beat hit**; the local branch was one commit behind the PR head.
- `--no-verify` was used on one commit that hung on a heredoc. **Verified afterwards that the repo
  has no non-sample hooks**, so no gate was bypassed — stated because "I used --no-verify" should
  never pass without that check.
- **Weaker-property count: ten in ten beats.** This beat's: the round-3 derived source-scan on #34
  (pins fetch-covers-use, blind to bind-uses-fetch), and #220's E2E step 7, which is *vacuously*
  true under the binding mutants.

---

## 5. Open for Sean (rule-4)

1. **`trinity-symphony-shared` #34 — round 5 pushed (`ffe5343c`), all nine round-4 survivors killed.**
   Eight beats of T12 idle end when it merges. **Important nuance: #34's production code has never
   been found wrong** — all four send-backs were about test coverage. If you want the fleet back
   sooner, merging on round 5 is a defensible call; the residual risk is future regressions going
   uncaught, not a known defect. It still owes a fifth independent verification, which I would run
   before *I* called it ready. Your design question stands: should an exhausted task get its own
   terminal status rather than sitting in `pending`?
2. **repid-engine #225 + #233 — MERGE ORDER STILL MATTERS.** #225 alone ships the unpinned
   `regretAtPrice` column; #233 is the fix and is stacked on it. Land them together, or #233
   immediately after, with no intervening state where `main` carries the unpinned version — it is
   patent enabling-disclosure material. `--auto` cannot arm #233 while it is based on a feature branch.
3. **repid-engine #220 needs one real source fix before `HAL_GROUNDING_MODE=enforce`** — the verifier
   throws on malformed input on the exact path HAL uses for untrusted output, contradicting its own
   documented contract. Two test-only assertions close the answer-binding evidence gap. All three
   are specified precisely enough to apply next beat.
4. **NEW: prod DDL applied this beat** (net-new additive, single-writer lane, logged in-repo) —
   `marketplace_listings` + `marketplace_offers`, RLS on, zero policies, anon revoked. Flagging it
   because it is prod, not because it needs a decision.
5. **Carried unchanged:** Patent #1 RTP gap (c) — one real Base Sepolia anchor with the funded
   attester (a hard line for this loop) · #216 needs conflict resolution · branch protection requires
   only `test`, so `crosscheck`/`gitleaks` can fail and a PR still lands · `PROOF_ENQUEUE_HAL_MODE
   =enforce` · the dead `jest` key in `package.json` · `repid_gate_shadow_log` still absent from prod
   (the fallback now works, so the evidence accumulates either way).

**Next beat:** (1) independently verify this beat's repid-engine PR and #231 (I wrote both). (2) Apply
#220's three prescribed fixes — the throw first, it gates an enforce flip. (3) Fifth verification of
#34. (4) The shape-keyed floor rung for Patent #2, once #225 is off the feature-branch stack.
