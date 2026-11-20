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

Expected, as observed on 2026-11-19 against the live service: a list of lines and a last line like `10 verified, 0 failed, 6 not checked`, exit code 0.

Six "not checked" is the normal result of this plain run: two chain lines (no `RPC_URL` set), two HAL lines (no `--hal`), and the two lines that are never verified today (agent binding, private disclosure). Each says why on its own line.

To also read the Base Sepolia test network directly, set `RPC_URL=https://sepolia.base.org` first. The two chain lines then move to verified and the last line reads `12 verified, 0 failed, 4 not checked`.

The counts come from live data, so a line's wording can change (for example when the agent's score has moved since its proof was made). `0 failed` is what a healthy backend gives; a FAILED line is a finding to read, not noise. This guide records what was seen on the date above, not a promise about every later run or every agent.

**2. A rejection case.** The same run, with one answer changed in memory to what a broken backend would send:

```
node scripts/trust-backend-conformance.mjs --plant wrong-agent
```

Expected: a `PLANTED DEFECT` line, exit code 1, and three FAILED lines: `zk proof read` (the proof names another agent) and the two lines that check the proof bytes against the statement: `zk verify (this API, real proof)` and `zk verify (published verifier, run locally)`. Both print a verifier error; the output does not say why, and the reason is that the planted statement names a different agent. The third verify line, `zk verify (this API, altered statement)`, still reads VERIFIED: it reports that an altered statement was refused, which is unchanged. The last line reads like `7 verified, 3 failed, 6 not checked`. Other rehearsals: `--plant altered-accepted`, `--plant simulated-receipt`.

## What each line proves

| Line | VERIFIED means | It does not mean |
|---|---|---|
| health, repid, passport, erc8004 validate | The API is up and its views of this agent agree on id, score and tier | That the score is correct: the lines show the views agree with each other, and this run cannot tell whether they share a source |
| zk proof read | A proof is published whose statement says "score >= threshold" and names this agent | Anything about the proof bytes |
| zk verify (this API, real proof) | The API's verify route accepts the proof it serves | An independent check |
| zk verify (this API, altered statement) | The same route refuses the proof when the stated score is changed by one | An independent check |
| zk verify (published verifier, run locally) | The proof bytes verify on your machine with `@hyperdag/proof-verifier` (the open-source verifier package, already installed by `npm ci`), by a WebAssembly module running in this process, not by a request to the API, and a changed statement is refused | That the proof belongs to this agent (next line) |
| zk agent binding | Never VERIFIED today: it always prints NOT_CHECKED with "Agent binding not verified". This proof format does not tie a proof to an agent id or to the exact score and threshold, only to the difference between them, so a valid proof cannot show whose it is | |
| zk private disclosure | Never VERIFIED today: it always prints NOT_CHECKED. The score and threshold are public inputs: a validity proof, not zero-knowledge | |
| reputation on chain (as the API reports it) | The API's own account of the agent's on-chain reputation record names the same token as the passport | That the chain agrees; this line does not read the chain |
| chain readback | The ERC-8004 registry on Base Sepolia names the same owner for the agent's token as the passport | Anything about the score |
| public receipt | The latest receipt is a real (not simulated) settlement with proofs listed | |
| settlement on chain | The receipt's transaction exists on the chain the RPC serves (the line prints the chain id; 84532 is Base Sepolia, a test network), succeeded, and transferred the receipt's amount, in the token's base units, to the receipt's payee | A mainnet payment, or which token: the line checks the transfer, not the token contract |
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

- **HAL and "uncertain".** Not exercised by the two runs above (it needs `--hal`). Measured separately on 2026-11-19 on a local server with free providers: with the engine's default settings, a claim every checker calls uncertain comes back `vetoed`, the word also used for a claim found false. Treat `vetoed` with `hal_score` 0.5 as "could not judge". Since that date the engine attaches no reputation penalty to a veto that no checker called false; the word returned is unchanged.
- **The proof is not tied to the agent.** A valid proof shows one thing: the stated score is above the stated threshold. The agent id, the two exact numbers, the tier and the time are labels supplied alongside it. A proof version that binds the subject is planned.
- **Scores can be older than proofs.** The proof line says so when the proved score and the current score differ.
- **This is a preview.** The script exercised these calls on the date above and passes or fails on what it finds each time you run it. Nothing here is a service-level promise, and the published builder contract does not cover these calls yet.

## Offline

`node scripts/trust-backend-conformance.mjs --save out` keeps every answer; `--offline out` reruns the checks against them. `npx jest --config jest.config.js tests/trust-backend-conformance.test.ts` runs the planted-defect suite, which builds its answers from a synthetic proof and uses no live data.
