# Trust backend: developer preview

What a new front end can rely on today, and one command that checks it. Everything here is keyless and read-only unless a line says otherwise.

## Try it (about two minutes)

You need Node 20 or newer and a clone of this repository.

```
npm ci --legacy-peer-deps
```

**1. An acceptance case.** Follow one real agent through the live API:

```
node scripts/trust-backend-conformance.mjs
```

Expected: a list of legs and a last line like `10 verified, 0 failed, 6 not checked`, exit code 0. To also read Base Sepolia directly, set `RPC_URL=https://sepolia.base.org` first; the two chain legs then move from "not checked" to "verified".

**2. A rejection case.** The same run, with one answer changed in memory to what a broken backend would send:

```
node scripts/trust-backend-conformance.mjs --plant wrong-agent
```

Expected: a `PLANTED DEFECT` line, `FAILED zk proof read`, exit code 1. Other rehearsals: `--plant altered-accepted`, `--plant simulated-receipt`.

## What each line proves

| Line | VERIFIED means | It does not mean |
|---|---|---|
| health, repid, passport, erc8004 validate | The API is up and its views of this agent agree on id, score and tier | That the score is correct; they all read one database |
| zk proof read | A proof is published whose statement says "score >= threshold" and names this agent | Anything about the proof bytes |
| zk verify (this API) | The API accepts its own proof and refuses a changed statement | An independent check |
| zk verify (published verifier, run locally) | The proof bytes verify on your machine with `@hyperdag/proof-verifier`, with no network call, and a changed statement is refused | That the proof belongs to this agent (next line) |
| zk agent binding | Never VERIFIED today. It reads "Agent binding not verified" | |
| zk private disclosure | Never VERIFIED today. The score and threshold are public inputs: a validity proof, not zero-knowledge | |
| chain readback | The ERC-8004 registry on Base Sepolia names the same owner for the agent's token as the passport | Anything about the score |
| public receipt | The latest receipt is a real (not simulated) settlement with proofs listed | |
| settlement on chain | The receipt's transaction exists on Base Sepolia, succeeded, and paid the receipt's payee the receipt's amount (test USDC) | A mainnet payment |
| HAL (two lines, only with `--hal`) | A known-false claim is not returned clean; an unknowable claim is returned abstain or flagged | Accuracy in general: two claims are a smoke test |

Three outcomes per line: VERIFIED, NOT_CHECKED (with the reason) and FAILED. NOT_CHECKED is never a pass. Exit code 0 only when nothing failed and at least one line verified.

## The calls behind it

Base URL `https://repid-engine-production.up.railway.app`.

| Need | Call |
|---|---|
| Is it up | `GET /health` |
| Score and tier | `GET /api/v1/repid/:nameOrId` |
| Everything about an agent | `GET /api/v1/passport/:nameOrId` |
| The proof | `GET /api/v1/repid/:uuid/proof` |
| Check a proof through the API | `POST /api/v1/proof/verify` with `{ proof_bytes, statement }` |
| Check a proof yourself | `verify(proof_bytes, statement)` from `@hyperdag/proof-verifier` |
| ERC-8004 view | `GET /api/v1/erc8004/validate/:nameOrId` |
| A settled exchange | `GET /api/v1/receipt/latest.json` |
| Check a claim | `POST /api/v1/hal/evaluate` with `{ text }`; a small per-address daily budget applies |

A POST body containing `;`, `--` or an SQL keyword followed by a space is rejected by a sanitizer, so plain claim text only.

## Known limits (read before you build on it)

- **HAL and "uncertain".** With the engine's default settings, a claim every checker calls uncertain comes back `vetoed`, the word also used for a claim found false. Treat `vetoed` with `hal_score` 0.5 as "could not judge".
- **The proof is not tied to the agent.** See the "zk agent binding" line.
- **Scores can be older than proofs.** The proof line says so when the proved score and the current score differ.
- **This is a preview.** These calls are live and tested by this script; the published builder contract does not promise them yet.

## Offline

`node scripts/trust-backend-conformance.mjs --save out` keeps every answer; `--offline out` reruns the checks against them. `npx jest --config jest.config.js tests/trust-backend-conformance.test.ts` runs the planted-defect suite, which builds its answers from a synthetic proof and uses no live data.
