# PLANNER run 2 (by hand): 2026-11-17

STATUS second test of the work cascade's §7 planner prompt (proposed). **Files only.** Nothing was inserted into `trinity_tasks`, nothing merged, no migration applied, no prod write of any kind.
RUN 2026-11-17, about 09:00Z to 10:10Z, by a Claude session. Branch `claude/planner-pass-3b0ba8`, based on `main` at `adaaeff0` (#1575).
READS the newest L2 file (the 2026-11-15 priorities), the L1 roadmap, the cascade document, run 1's report (2026-11-16) and the repo's lane code.
TAGS **[V]** = I read or ran it this run (gh, SQL read, chain RPC read, test, grep). **[R]** = from a named document or another session, not re-checked. **NOT_CHECKED** = could not or did not check.
PUBLIC REPO: this file states findings, not identifiers. Private evidence (scratch scripts, the gate's full JSON) is in the session's notes folder, not here.

---

## Digest (one screen)

- **`ops/t12/specs.jsonl` is intentionally unchanged.** The brief assumed 10 specs on file. There are **34** (10 from #1532 and the 24 that run 1 added in #1571). 24 are claimable today; that is not below the refill line of 24. Appending would be padding. Reasons are in §3.
- **Why 24 and not 34:** 9 of the 10 oldest specs are frozen inputs of a preregistered study (their text must stay byte-identical, so I did not edit them, not even to add the cascade fields), and the tenth already has an approved result nobody integrated.
- **Re-proved today:** on trustshell `main` (`1c098ca`) the run-1 gate passes **24/24**: red on main, green with a type-checked reference test, **76/76 controls caught**, discriminating and type-clean, clone clean after (372 s). All 34 specs also still apply to main (targets absent, every control's text present, none multi-line), checked by a script that I shot at three induced defects first. `t12-specs-valid` and `t12-ab-context` pass (49 tests) [V].
- **The queue is still empty.** 0 rows from the replenisher, 0 in the lane pool, with a presence control [V SQL]. All 12 agents `idle: loop advancing, no task held` [V]. The bottleneck is arming (Sean's MAJOR steps, §4), not planning.
- **L2 (W1 to W24, 24 rows):** closed **6** (W1 to W5, W13), each with evidence. Blocked **6** with the blocker (W7, W8, W9, W11, W12, W23). Open **12**. Added **2** (W25, W26). Re-ranked W8 up to #3. Patch for the L2 file is in §2.6.
- **Landed since run 1 [V gh]:** #1555 (look-only key), #1568 (gasless follow-ups), #1569 (x402 v2 challenge), #1570 (HAL score gate, shadow), #1572 (payment anchor, shadow), #1573 (agent names unique); trustshell #720 to #726. All of them are in the deployed commit [V `/health` plus ancestry]. Two of them need prod DDL that is **not applied** [V].
- **Meters:** Claude weekly **46%** (limit for new dispatch is 85%), extra spend $0.00 of $50 [V `get_usage`]. Grok: **unconfirmed**, last loop row `pool_exhausted` at 07:05Z, and with no open PR the loop has had nothing to review since (§0). **No repo is at the PR cap** [V].
- **MAJOR for Sean: 15 one-liners** (§4). Most time-bound: the Mozilla fit call and proposal (Nov 20, 23:59 PST, 3 days) and the Agentware registration (before Nov 23, 6 days).

---

## 0. Meters (§7 step 0)

| Meter | Reading | Source |
|---|---|---|
| Claude plan, weekly all models | 46% used, resets 2026-11-18 04:00Z; Fable-only weekly 0% | [V `get_usage`] |
| Extra usage | $0.00 spent of $50.00 | [V same] |
| Grok loop | Last 3 state rows are all `pool_exhausted` on PR #1566, the latest 2026-11-17T07:05:40Z. #1566 merged 08:19Z, so **no row exists after any top-up**. The loop only reviews an open ready PR (or a labelled one), and `repid-engine` has had none since. Whether the pool is funded: **NOT_CHECKED**. #1555's body does report a Grok NO_FINDINGS on its head, so a Grok run worked at some point. This draft PR carries the `grok-review` label so the loop's next tick gives the reading | [V `grok-review/state.jsonl` tail; V gh #1555 body] |
| Lane queue | `insert_source='t12-lane-replenish'`: **0**. `assigned_to='trinity-t12-lanes'`: **0**. Presence control: the same table has rows for other sources (`claude-sprint` and `system` created in the last 24 h) and `v_agent_state` returns 12 rows | [V SQL, read-only] |
| Fleet | 12 of 12 `idle`, evidence `loop advancing, no task held` | [V `v_agent_state`] |
| Deployed engine | `/health` `deployed_commit` = `adaaeff0` = `main` head. #1555, #1556, #1557, #1558, #1559, #1568, #1569, #1570, #1572 and #1573 are each an ancestor of it | [V curl; V `git merge-base --is-ancestor`] |
| npm | `@hyperdag/trustshell` `latest` = 1.9.3 | [V `npm view`] |
| Open PRs (every one, with a disposition, per r26) | repid-engine: **none**. trustshell: #727 (Dependabot minor bump: leave to the normal flow), #696 (draft, "do not merge": leave). HyperDAG-core: #22 (docs: "not agent-bound, not ZK": Sean's merge, §4), #21 (Dependabot: leave). t12-dogfood-sandbox: #1 (the g25 test PR, open since 2026-11-10: review status NOT_CHECKED, needs an integrate-or-close call) | [V `gh pr list`, all four repos] |
| PR cap (D-189: 3 per repo per account) | mine: repid-engine **0**, trustshell **1** (#696), HyperDAG-core **1** (#22), sandbox **1** (#1). **No repo is capped**, so specs that end in a new PR are allowed in all four | [V `gh pr list --author @me`] |

## 1. What changed since run 1 (§7 step 1)

Run 1 ended about 21:20Z on 2026-11-16 [R its report]. Since then [V gh unless noted]:

- **Engine merged:** #1555 look-only key (05:59Z), #1569 x402 v2 challenge, #1570 HAL score gate (shadow, default off), #1571 run 1's specs, #1572 payment anchor (shadow, default off), #1573 agent names unique, #1566/#1567/#1568 review fixes, #1575 no RPC URL in stake responses.
- **trustshell merged:** #720 (loop strip), #721 ("watch an agent get caught"), #722 (live owner-budget run on TrustMarket, MAJOR), #723 (plain words, no endless spinner), #724 ("what works today"), #725 (newcomer wallet step: **design only, not built**), #726 (each PAI under its own name).
- **Applied by Sean, found by reading:** the unique-names index exists on the agents table [V `pg_indexes`], so #1573's SQL step is done.
- **Not applied, found by reading:** neither shadow table for #1570 nor the replay table for #1572 exists [V `information_schema`]. Both PRs are inert until Sean applies them and sets their flags.
- **New documents [R, titles and dates only]:** a three-evaluation implementation sequence (2026-11-16), the Mozilla facts sheet (2026-11-16), a Marco preparation file (2026-11-16). The sequence's Tier 0 matches W14, W19, W21, W22, W24; its Tier 1 items became #1570 and #1572.

## 2. L2 diff (this week)

The L2 file's W1 to W13 rows still read as open (nobody applied run 1's diff: finding F9). So this diff is against **the L2 file as it stands**, with run 1's rows W14 to W24 carried in. Each "done when" is the one observable fact I used to close or keep a row.

### 2.1 Closed (evidence cited)

| Row | Closed on | Evidence |
|---|---|---|
| W1 1.9.3 release | npm `latest` = 1.9.3; trustshell #719 merged 2026-11-16 07:46Z | [V `npm view`, V gh] |
| W2 owner-budget run `--execute` plus receipt | **All four transactions in the receipt exist on Base Sepolia and succeeded** (4 of 4 `eth_getTransactionReceipt`, status success, blocks within about 100 of each other). Run 1 had this as [R]. **Limit that stays:** balances and the ten refusals are in the receipt and in Chat's replay only. A refusal leaves no transaction, so no chain read can show it | [V public RPC read; R receipt file] |
| W3 independent replay from chain | Chat: SUPPORTED for the four receipts and the escrow outflows; balances, DB reservations and refusals NOT_CHECKED by a chain-only replay (they cannot be seen there) | [R Chat's report; not re-run] |
| W4 ERC-8004 link and double write | #1556 merged and deployed. Duplicate check over the last 7 days: 7 writes, 7 distinct contracts, **0** contracts with more than one write, 0 with a NULL contract id. **But the newest write predates the fix** (2026-11-16 12:01Z against the merge at 16:44Z), so the check cannot yet show the fix working. **Next real test: the 2026-11-17 12:00Z cron write**: one write for its contract, `contract_id` set | [V gh, V SQL; behaviour after the fix: NOT_CHECKED, due after 12:00Z today] |
| W5 unbind and allowance | #1559 merged and deployed | [V gh, V ancestry] |
| W13 verified-human budget | #1557 merged and deployed, inert until its flag is on. Whether the flag is on: NOT_CHECKED (reading it needs the look-only key, W8) | [V gh, V ancestry] |

### 2.2 Blocked (blocker named)

| Row | Blocker |
|---|---|
| W7 Rehearsal 3 | Sean's go. NOT_CHECKED whether given. The last 24 h hold 40 `claude-sprint` and 24 `system` rows and none pending; whether any is rehearsal 3: NOT_CHECKED |
| W8 Wave 1 shadow flags (**now four, see §4**) | Sean on Railway. #1555 is merged and deployed, so after Sean mints the look-only key an agent can read the flags; until then every flag value is NOT_CHECKED |
| W9 HAL arm A on the sealed holdout | Sean's OK to read the holdout. The #1570 shadow gate is a different instrument (per score event, no holdout) and does not close it |
| W11 Agentware design in prose | The organizers' answer (NOT_CHECKED). Searching the launch folder and the last two days' sprint folders finds only mentions, no design file [V grep] |
| W12 / W23 ZK B1 and the tier-bound prover | Step zero: the two prototype branches are **not on `origin`** of `repid-engine` or `HyperDAG-core` [V `git ls-remote`]. Other remotes: NOT_CHECKED. Both still live only on another machine, so nothing here can build on them |

### 2.3 Open (no evidence of progress)

| Row | Check | Reading |
|---|---|---|
| W6 Mozilla facts | facts sheet exists (written 2026-11-16, 45 KB, draft, "Sean writes the proposal") | [V file read, first section]. Its first finding is that **fit risk is high** for this call, a decision for Sean (§4). Whether any proposal exists: NOT_CHECKED |
| W10 precision answers | the reply draft's last write is 2026-11-16 00:56 local, before the evaluation's findings, so it has **not** absorbed them yet; a Marco preparation file exists | [V file times] |
| W14, W15 TrustShell contradictions, earlier attempts | no open or merged trustshell PR touches them (the only open ones are #727 and #696) | [V `gh pr list`] |
| W16 receipt fields (grant epoch, runtime-code hash) | searched `src/` and `scripts/` for `grant_epoch`, `runtime_code_hash` and spelling variants in `*.ts` and `*.mjs`: **no match** (not searched: `reports/`, `docs/`, SQL, JS outside those two folders) | [V grep] |
| W17, W18 test nets | specs ready (§3) | [V] |
| W19 7-leg harness fix | not on `origin` (see W12 note) | [V ls-remote] |
| W20 engine tests import without DB env | `src/config.ts` still throws without Supabase env unless `LOCAL_MODE` is set (lines 84 to 86). Whether `npx jest` with no env has 0 import failures: NOT_CHECKED (not run) | [V read] |
| W21 stub strings | one **served** placeholder, `src/routes/agents.ts:329` (`merkleRoot: '[ZKP commitment … ValidationRegistry]'`), plus ten other lines that are all comments, across five files (`repid-update`, `constitutional-audit`, `agents`, `outcome-classification`, `shadow-scoring`). The served one is the claim a stranger can hit | [V grep, enumerated: `src/**/*.ts`] |
| W22 SOPHIA #3747 on-chain hygiene | needs Sean's key; no chain read this run: NOT_CHECKED | — |
| W24 prover 422 | not started (the prover is outside this repo's `src/`) | NOT_CHECKED |

### 2.4 Added (every §2 field; weight per r31)

| Row | Outcome | L1 | Done when (one observable fact) | Depends on | Lane | Weight · stage |
|---|---|---|---|---|---|---|
| **W25** | The newcomer wallet step exists: **one passkey tap** creates a wallet and approves a capped, testnet-only budget; the PAI does every other step | M1, M2 | a recorded stranger-walk (fresh browser profile, no wallet) reaches "budget granted" with a receipt showing chain id and caps, and `ONBOARDING_FRICTION_LOG` has **0** stops at faucet, ETH, or raw key | the design is merged (trustshell #725, **design only**); W13's flag and the gasless-deposit flag are on (Sean) | Chat/Codex on trustshell, Claude on the engine | **MAJOR** (auth, keys, money; Sean decides the merge) · smoke then canary |
| **W26** | The first measured agreement between the new shadow gates and live outcomes | M3, M5 | 7 days of shadow rows from the HAL score gate, the payment anchor and the delivery check, and one table "shadow verdict vs live outcome" with its ruler (window, N, per-provider failures) in `reports/` | W8: Sean applies the two shadow DDLs and sets the flags | Claude (read-only analysis); later an evergreen loop | LOW (read-only) · shadow |

### 2.5 Events and deadlines (dates checked against today, 2026-11-17)

| Event | Date | Enters L2 as |
|---|---|---|
| E1 Mozilla proposal | Nov 20, 23:59 PST (**3 days**) | W6 stays #1; the fit decision is Sean's (§4) |
| E2 Agentware library question and team registration | before Nov 23 (**6 days**) | Sean action (§4) |
| E3 Agentware entry, new code | Nov 27 to 30 | W11 (design first); needs organizer approval |
| E4 HAL hardware and Black Friday decision | by Nov 27 | depends on W9 |
| E5 Near Miss write-ups (3) | by Dec 7 | not expressible as an L3 spec (F1 below); drafts from the friction log |

### 2.6 Re-ranked, and the patch for the L2 file

Order now: **W6, W10, W8, W14, W16**, then W17, W18, W25, W26, then the rest. Why W8 rises to #3: it is Sean-only and takes minutes, and it unlocks W4's and W13's readings and all of W26. Why W6 and W10 stay on top: E1 is 3 days away and W10 feeds every outreach answer.

Patch (a person or the planner session applies it to the L2 file; this run does not, because the file lives outside the repo and its fence): W1 DONE · W2 DONE (4/4 txs verified) · W3 DONE with named limit · W4 DONE (code), behaviour check due after the 12:00Z cron · W5 DONE · W13 DONE (code), flag off, NOT_CHECKED · W8 blocked on Sean, **four** flags, two DDLs first · W7, W9, W11, W12 blocked as above · add W14 to W26 with the "done when" values from this file and run 1 · put the Done-when column in the table (F5).

## 3. L3: what is ready, and why nothing was appended

### 3.1 The count (F4's definition: on file, valid, target absent on its base, no approved result, not reserved, not in the database in a terminal stage)

| | n | Note |
|---|---|---|
| Specs on file in `ops/t12/specs.jsonl` | **34** | all `DealAppSeo/trustshell`, all LOW, all one-shot |
| ... of which in the database | 0 | the replenisher has never inserted [V SQL] |
| Reserved by the preregistered context study | **9** | each has a packet under `ops/t12/ab/ctx-v1/`, and the study's arm A is "the spec byte for byte", so their text is frozen. Replenishing them as ordinary work would also burn the cohort, because the study excludes a task solved outside it. Whether the study is still open: **NOT_CHECKED** (Sean's call) |
| Already solved, not integrated | **1** | `ts-repid-to-tier`: lane run on 2026-11-11 ended `approved` on its first attempt (a free 7B model on a runner; the checker ran its 2 controls; evidence class `same_controller_rerun`, so not independent) [V `gh run view`: success; R the run's README]. Its test file is **not** on trustshell main [V]. Integrate it (LOW) or drop the spec before any replenish |
| **Claimable now** | **24** | the 24 run-1 specs |

24 is not below 24, so no refill is due. The 10 pre-cascade specs lack the cascade fields (`@l2`, stage, budget, loop, red-proof). I did **not** add them: editing a reserved spec breaks the study, and the tenth is solved. Their mapping, by the area they test, so the next planner can read them: `ts-claim-label-of`, `ts-terminal-safe-json` → W14 · `ts-as-of-epoch`, `ts-seen-by-from-hal` (closest fit, ambiguous) → W16 · `ts-api-url-refusal` → W17 · `ts-repid-to-tier`, `ts-after-create-table`, `ts-short-address`, `ts-parse-autonomy`, `ts-profile-check-text` → W18. They all sit at a flat priority 80, so if they were replenished the W18-mapped ones would outrank W17's 75. They are reserved, so this does not bite.

### 3.2 Re-proved today (the "red once on main" proof, run again)

Base: trustshell `main` at `1c098ca` (after the newcomer PRs), cloned fresh and installed with `npm ci`. Gate = the four-part check from run 1 §4, run unchanged on the 24 claimable specs with their private reference tests (kept outside every repo, never given to a maker):

1. **Red on main:** the checker's own command with no test file exits non-zero (`--passWithNoTests=false`; trustshell's own jest config would pass it) → 24 of 24.
2. **Green with a correct test:** all reference tests in one type-checked jest process → 24 of 24.
3. **Every control caught:** the reference test fails under each → **76 of 76**.
4. **Every control discriminates and is type-clean:** an import-only test still passes under it and it adds no TypeScript error → 76 of 76.

Result: pass 24/24, 372 s, clone clean afterwards [V, full JSON in the notes folder]. I did not diff the code under test since run 1; the gate result is the evidence, not an assumption that nothing moved.

**Readiness of all 34 against `1c098ca` [V]:** target absent on main · control file present · every control's text found · no control spans lines (a multi-line `find` never matches a CRLF checkout, F13). **Negative control:** I fed the same script three induced defects (a find text that is not in the file, a target that already exists, a multi-line find) and it flagged all three, so a clean answer was possible to refuse.

Also run: `tests/t12-specs-valid.test.ts` and `tests/t12-ab-context.test.ts`, **49 passed** [V].

### 3.3 Why none were appended

The refill rule is not met, the feeder is unarmed (0 rows reach the queue whether there are 24 specs or 40), and every added spec needs a reference test, controls and a gate of its own. That is real work for no change in what runs. A conservative buffer of 8 would be reasonable the first time a lane claims a spec; the candidates are below so that refill is quick.

### 3.4 Next refill candidates (names only; **purity NOT_CHECKED**, read each before specifying)

Exported functions on trustshell main that no test names and no spec prompt mentions [V scan]:

- `lib/why-questions.ts`: `whyQuestion` · `lib/stake-onchain.ts`: `basescanTx` · `lib/honesty-a.ts`: `fixtureCard` · `src/lib/profile.ts`: `personalSectionsSet`, `renderPersonalSection` (all W18, the newcomer path)
- `src/lib/guardrails.ts`: `recordHash`, `nonceHighWater`, `policySigner`, `policySignedBy` (W17) · `src/lib/bundle.ts`: `unsafeText`, `bundleProblems` (W16)

The rest of the scan hits are network or browser-storage code (`fetch*`, `localStorage`), which a unit test cannot cover without fixtures.

### 3.5 Routing (§3)

Unchanged from run 1: 16 specs go to the free lane first, 8 to a paid-in-plan lane first (large typed fixtures or async rejection checks). One new fact for the record: on 2026-11-11 a free model completed the simplest spec on its first attempt, while the preregistered study found 0 of 4 arms verified in 2 scored pairs on two harder specs [R, study reconciliation]. That is n = 1 against n = 4, both on the same lane, so it moves nothing from "probe" to "relied on". Not routed to Grok review: its meter reads unconfirmed (§0).

## 4. MAJOR items for Sean (one line each: what changes · the risk · the rollback)

1. **W8: set the shadow flags** `SERVICE_DELIVERY_CHECK_MODE=shadow`, `EXPERIMENTAL_REPID_MODE=shadow` and, new since run 1, `HAL_SCORE_GATE_MODE=shadow`, `PAYMENT_ANCHOR_VERIFY_MODE=shadow` on the engine service · shadow rows and provider calls start; no score, delta or class changes (each PR pins this) · extra provider cost and load · unset the four variables.
2. **Apply the two shadow migrations (prod DDL)**: the HAL score gate's table (`20261116180000`) and the payment anchor's replay table (`20261116130000`) · adds two new tables; #1570's is empty, takes no lock on existing tables and has RLS on (per its PR), #1572's is a replay table (details in its PR) · a paste into the wrong project · drop the two tables (#1572 ships its rollback beside the migration; #1570's: NOT_CHECKED). Neither table exists today [V].
3. **Mint the look-only key** (`OPS_READ_KEY` on the engine service, then the one command in #1555) · a key that reads the flags list and nothing else; any other call gets 403 · a leaked key shows which switches are on · delete the variable.
4. **W13: `HUMAN_SBT_OWNER_BUDGET_ENABLED=true`** · a verified-human owner gets the shared testnet budget · that owner's agents can spend testnet USDC · set it back to false.
5. **`GASLESS_DEPOSIT_MODE` on** (code in #1558, follow-ups in #1568, both merged) · the escrow relays owner deposits and pays the gas · a failed relay may still have moved USDC (#1568 handles it); the global 4-per-minute limit can be griefed (the open call in #1568) · flag off.
6. **W22: SOPHIA #3747 writes from the owner key** (revoke the 10 legacy feedback entries, set the current registration shape, set or explain the agent wallet) · the flagship agent's public record · irreversible chain writes; a revoked entry stays visible as revoked · URI and wallet can be set back, a revoke cannot.
7. **W23 / W24: serve a tier-bound proof, and stop storing stub proofs** (the 56,823 old stub rows: archive, never delete in place) · what a live proof states · existing badges and verifiers may reject new proofs · keep serving the old statement behind a flag.
8. **M3: key-graded RepID live** after two agreeing shadow runs (whether they agree: NOT_CHECKED) · scores move on answers · wrong scores for real agents · back to shadow.
9. **E2 Agentware:** post the library question and register the team before Nov 23 · an outward post · none beyond the post.
10. **W6: decide whether to apply to the Human-Scale AI call at all** (the facts sheet rates fit risk high) and, if yes, write and submit by Nov 20, 23:59 PST · an outward submission; four days of effort · none (whether a submission can be withdrawn: NOT_CHECKED).
11. **W7: Rehearsal 3 go** (≤24 tasks, ≤3 workers, ≤8 h, shadow only) · free-tier use overnight · quota burn, no score moves · stop the conductor.
12. **Grok pool:** confirm which grok.com account the CLI uses and that a review now answers (this PR is the probe) · until then D-161 cannot merge a LOW or MEDIUM PR (it needs Grok) · n/a.
13. **T12 production unlocks (cascade §8):** the worker-role migration (prod DDL), the worker database URL, a one-repo PR token that cannot merge, then the planner on a schedule, then replenish inserting by itself · free lanes write to prod tables and open PRs · a mis-scoped role or token · drop the role, revoke the token.
14. **Study T12-CTX-AB:** keep it open (its 9 specs stay out of replenish) or close it (they become ordinary work) · if closed, the preregistered comparison is lost · a task solved outside the study is excluded from it, so closing it is not reversible in practice.
15. **Carried, status NOT_CHECKED:** merge HyperDAG-core #22 (docs only) · the trustmarket.dev copy · the local-model pilot's downloads, enclave and spend cap · freezing Immune expansion until M1.

## 5. Prompt and process fixes (what is new since run 1's F1 to F13)

Run 1's F1 to F13 still stand: the cascade file dated 2026-11-16 18:17 local still has step 4 unchanged ("write specs from the top open L2 rows", which the lane format cannot express: F1), no Done-when column (F5), no repo list in step 0 (F12), no owner for the L2 patch (F9) [V read of §7]. New:

- **F14. "Ready" must exclude reserved and solved specs.** A preregistered study freezes a spec's bytes; a solved spec wastes a claim. **Fix:** a field on the spec (`reservedBy`, `solvedBy`) that `replenish()` skips, and the count in step 4 reads it. Today only a human reading the A/B folder knows.
- **F15. The meter for a funded Grok pool has no reading when nothing is waiting.** The loop writes a state row only when it calls Grok, so "funded again" cannot be checked from its file. **Fix:** a cheap heartbeat row (a one-token call, daily) so step 0 has a reading.
- **F16. A brief's count is a claim.** The brief said 10 specs on file; the file holds 34. Step 4 must start from the file, not from the prompt that launched the run.
- **F17. Step 5 can be mechanical.** `gh pr list --author @me` per repo gives the cap in one line each, now in §0. Put the four repos in the prompt.

## 6. NOT_CHECKED in this run

- Whether the Grok pool is funded (no loop row after any top-up; no ready PR to review).
- The flags on the engine service, `HAL_CONFIG_FROM_DB`, and whether W13's flag is on (no look-only key).
- Anything on the other machine: the two prototype branches, the evaluation's fixes. Other remotes than `repid-engine` and `HyperDAG-core`.
- Whether Sean gave Rehearsal 3 its go; whether the Agentware organizers answered; whether a Mozilla proposal exists.
- The chain for W22, and W24's prover (outside this repo).
- Behaviour of W4's fix after the 12:00Z cron today.
- Whether the preregistered study is still open.
- Reference tests for the 10 pre-cascade specs: not located (only the gate result recorded in #1532), so their "green with a reference test" and "controls caught" were **not** re-proved today. Only their readiness (target absent, controls apply) was.
- Whether any free lane can do the 24 specs beyond the n = 1 above: nothing ran a model this run.

## Appendix: re-run the readiness check

```js
// node ready.cjs ops/t12/specs.jsonl <fresh trustshell clone at main>
const fs = require('fs'), path = require('path');
const [specsFile, clone] = process.argv.slice(2);
for (const s of fs.readFileSync(specsFile, 'utf8').split('\n').filter(Boolean).map(JSON.parse)) {
  const bad = [];
  for (const p of s.paths) if (fs.existsSync(path.join(clone, p))) bad.push('target exists on main');
  (s.verify.controls || []).forEach((c, i) => {
    const f = path.join(clone, c.file);
    if (/[\r\n]/.test(c.find) || /[\r\n]/.test(c.replace)) bad.push(`control ${i + 1} spans lines`);
    else if (!fs.existsSync(f)) bad.push(`control ${i + 1} file missing`);
    else if (!fs.readFileSync(f, 'utf8').includes(c.find)) bad.push(`control ${i + 1} text not found`);
  });
  console.log(s.id.padEnd(28), bad.length ? 'STALE ' + bad.join('; ') : 'ready');
}
```

Prove it can say "stale" before trusting "ready": change one `find` to text not in the file and expect `STALE`.
