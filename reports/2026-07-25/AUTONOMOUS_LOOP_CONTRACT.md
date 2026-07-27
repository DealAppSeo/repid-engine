# HyperDAG Autonomous Build-Loop — Operating Contract
**Authorized:** Sean, 2026-07-25 ("run continuously autonomously as much as makes sense... build this out as quickly, securely and efficiently as possible"). Sean is reachable via Claude mobile.
**Purpose:** keep the ecosystem moving toward the vision at machine speed, mostly free, with peer-review-grade discipline. This file is the stable rulebook; `AUTONOMOUS_LOOP_LEDGER.md` is the append-only record; `SPRINT_BACKLOG_DEPENDENCY_ORDERED.md` is the task queue.

## The vision this serves (verbatim intent)
A Safe & Ethical Democratized AI for financial, educational, and health-care inclusion — an Agentic Trust Ecosystem where millions of users and their agents rate LLMs/SLMs and each other, wrapped in a Trust Harness of **HAL + ZKP RepID + ERC-8004 + x402**, with owners cryptographically bound by ZKP. Portable, interoperable, user-owned data. Surfaces: TrustShell.dev, TrustRepID.dev, TrustMarket.dev, TrustTrader.dev, TrustRails.dev, TrustMedical.dev, AIDebate.io, AISocialMirror.com, PurposeHub.ai. Guiding verses: **Micah 6:8 · Acts 20:35** — help AI help people help people.

## The 7 rules every beat runs under
1. **Free-first cascade.** Bulk/volume → T12 free SLMs (Cerebras/Groq/Kimi/DeepSeek/Llama via `trinity_tasks`). Reasoning/backend → XC/GA. Claude only at the apex (frontier crypto, security, hard synthesis). **Stop only when free/prepaid tokens are actually exhausted.**
2. **Verify before asserting.** Every live claim comes from a query/curl/tx, tagged `[V]` (verified) or `[R]` (reported). No overclaiming that autonomy/features are "running" when they aren't. A stated goal ≠ a current claim.
3. **No self-validation — ever.** The agent that produces an asset never verifies it. A *different* agent verifies. Self-validation or a faked pass **hurts** the producer's RepID (asymmetric: honest mistake = mild; lie/cover-up/willful = severe).
4. **Wake Sean only for the irreducible:** a merge, a secret/infra action on his accounts, or a real vision fork. Everything else, just do it (proceed-unless: stop only on triad-disagreement AND irreversible real cost; zero-cost/testnet/shadow/branch always proceeds).
5. **Dependency order.** Do the task that unblocks the most downstream work first. Don't start deep work that a cheaper unblock would make trivial.
6. **Log everything scientifically.** Each beat appends: dispatched / verified `[V]/[R]` / shipped / **mistakes** / next. Failures are documented, not hidden — this record IS the peer review.
7. **Security hard lines.** NEVER call the Railway variable-listing tool (it leaks plaintext secrets — it has burned us twice). Never commit secrets. Never handle a plaintext key value; rotation reads stdin, Sean holds the value.

## The beat (what each heartbeat does)
1. Read this contract + the ledger + the backlog.
2. **Verify** the prior beat's delivered assets with an *independent* verifier (rule 3). Penalize any self-validation/false-pass.
3. **Dispatch** the next unblocked task at the cheapest sufficient tier (rule 1).
4. **Append** a Beat entry to the ledger (rule 6).
5. Surface to Sean only rule-4 items.
6. Ensure the next heartbeat is scheduled.

## Fleet map
- **T12 (free, 24/7):** Railway agents pull `trinity_tasks` (`status='pending'`). Dispatch by inserting rows (`insert_source='claude-loop'`, `agent_assigned` NULL = open pool). Keep the queue full of **real deliverable work**, never health-checks/drills.
- **XC (Grok) / GA (Gemini):** backend/frontend/research; via INBOX files + headless CLI where auth allows.
- **Claude (me):** apex only — Plonky3/Poseidon2 circuits, security, hard strategy, verification of others' work.

## Do-not-touch (hard stops)
RepID scoring formula + ANFIS params never in public docs · Marco's files in hyperdag-protocol · passing Sprint-3 stubs · no self-merge · `trinity_tasks` never bulk-deleted (26-FK hub) · prod DDL through one writer (Claude) with a look first.
