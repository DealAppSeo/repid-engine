# KERNEL SPRINT — policy kernel + three-leg receipt MVP (status of record)

**Opened 2026-10-12** · orchestrator: CC (Opus) · merges: Sean only · branch per repo: `claude/bold-turing-icz50x-kernel`.
Outcome vocabulary throughout: **VERIFIED / NOT_CHECKED / FAILED** — never two outcomes collapsed into one.

This is the in-repo status so a new session can pick up the lanes, the schema and the current PR state
without the chat. It is orchestration, not code; the kernel lives in the PRs named below. NARRATIVE until a
leg is VERIFIED against a real CI run.

## What the MVP is
The kernel, the receipt, and **a tool call the policy refuses**. The acceptance test is a *refusal* producing
a well-formed three-leg receipt with `executed:false` — not a purchase. The x402 buy is V1 and needs the
operator's GO + a funded wallet; it is **not** in this sprint.

### Hard constraints (non-negotiable)
- **Default-deny before the tool.** Verdict starts at DENY; ALLOW is earned only when every required check passed. Unknown tool class, missing policy, missing check → deny.
- **NOT_CHECKED blocks a spend and a post.** A required check that did not run is never a pass.
- **Spend limit defaults to `"0"`.** A policy that omits a limit has set it to zero.
- **One receipt**, `kernel-receipt/1`, across decision / payment / verification. A leg that did not happen says so.
- **Signed owner policy** (EIP-712), verified against the agent's accountable root. Revocation unreachable → NOT_CHECKED.
- **No key on disk. No new env var. No DDL** (receipts are append-only JSONL). **Laya logs in shadow, enforces nothing.**
- No STARK, no Graphiti, no real stake. EZKL is Halo2/KZG if asked. ERC-7715 is not a dependency until a Sepolia grant succeeds.
- Do not touch Marco De Rossi's files under `packages/contracts/`.

## Lanes — file-level, and they do not cross. Same-repo workers get worktrees before the next push.
**CC1 — kernel + receipt schema.** repid-engine `src/kernel/{types,decide,policy,receipt,gate,store}.ts`,
`src/kernel/schema/kernel-receipt.v1.json`, `src/kernel/__tests__/*`, `src/routes/kernel.ts`, one mount in
`src/index.ts`. trustshell `src/lib/kernel-client.ts`, `schemas/kernel-receipt.v1.json` (byte-identical copy),
`examples/kernel-buy/kernel-buy.mjs` (scaffold only — dry unless armed, signs and never sends), one export line.
Done when a refused tool call, a bad signature, a payee not on the list, and a NOT_CHECKED **each** produce a
receipt and do **not** spend.

**XC1 — known-answer table + red team.** A different worktree. Table rows are `{hash, label, checker_pair,
date, role}` — trick questions and pinned benchmarks only, **no sentence stored** (plaintext held off-repo), used
as seed / canary / holdout. XC1 reviews CC1's branch **read-only** and posts findings; it does not push to CC1's branch.

## Receipt `kernel-receipt/1` — invariants enforced in code
DENY/NOT_CHECKED ⇒ `executed:false`; ALLOW spend ⇒ `amount ≤ effective_per_tx_raw`; a required NOT_CHECKED on a
spend/post ⇒ verdict ≠ ALLOW; a 2–1 verification ⇒ `verdict_label PROVISIONAL`, SETTLED needs non-null `settled_by`;
`counts_toward_band_restore = grounded && same_domain && !is_simulated` (derived); `executed:true` needs a persisted
decision row first; no key/secret material anywhere.

## Long-loop rules (beyond MVP)
A 2–1 sets the **provisional** label only; RepID settles on a holdout, a known answer, or a person. Third
verification family is **commit-then-reveal** and is **V1, not this sprint**. Band restore counts only grounded,
same-domain, not-simulated actions.

## V1 (only after the kernel path produces a real receipt on CI) — in parallel, NOT on kernel files
commit-then-reveal (3rd family) · band-restore (grounded same-domain only) · 24-hour wait on a widen · tool pin by
hash · canaries wired to the table · rate limits. Spec and tests first. No Graphiti, no public full text, no validator slashing.

## STATUS (2026-10-12, re-date each line when it changes)
| leg | state |
|---|---|
| CC1 kernel — repid-engine **#1317** | CI-GREEN (CI, crosscheck, gitleaks, CodeQL, HAL-adversarial-gate all success); refusal demo 133 tests; non-vacuity proven by source mutation. DRAFT — Sean merges. |
| CC1 kernel client — trustshell **#515** | CI-GREEN (required `check`, CodeQL, secret-scan success). DRAFT — Sean merges. |
| XC1 known-answer table + red team | IN FLIGHT (its own worktree + branch) |
| MVP acceptance — a refused tool call → DENY receipt | the refusal demo is green in CI; a receipt on the live engine path is the V1 gate |
| x402 BUY dogfood (V1) | DEFERRED to Sean (irreversible; funded wallet + key-custody decision) |

**Verification rule:** a leg is VERIFIED only on CI, never on a worker's local report. CI green + the refusal demo
is the evidence. Sean merges; this session reports green or the reason it is not.
