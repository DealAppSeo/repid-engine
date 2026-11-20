# Trust backend: developer preview

What a new front end can rely on today, and one command that checks it. Everything here is keyless and read-only unless a line says otherwise.

## Try it (about two minutes without the optional install)

You need Node 20.9 or newer, git, a network connection (every run calls the live API) and a clone of this repository. Run every command below from the repository root. Nothing needs to be installed for the two cases.

**1. An acceptance case.** Follow one real agent through the live API:

```
node scripts/trust-backend-conformance.mjs
```

Expected in a fresh clone, as observed on 2026-11-20 against the live service: a list of lines and a last line like `9 verified, 0 failed, 7 not checked`, exit code 0.

Seven "not checked" is the normal result of this plain run: two chain lines (no `RPC_URL` set), two HAL lines (no `--hal`), the two lines that are never verified today (agent binding, private disclosure), and `zk verify (published verifier, run locally)`, which says the verifier package is not installed. Each says why on its own line.

**Optional: check the proof on your own machine.** The local verifier line needs the repository's dependencies:

```
npm ci --legacy-peer-deps
```

After it, the plain run reads `10 verified, 0 failed, 6 not checked`. Before you start it, know what it is: it installs the whole engine's dependency tree (575 packages on 2026-11-20), not one package. One clean install on that date took 40 minutes; the cause was not measured, so yours may be much faster. It prints deprecation and `npm audit` warnings that this guide has not assessed. The verifier itself is fetched from GitHub with git, and the lockfile records it over SSH; a machine with no GitHub SSH key was not tested. If the install is skipped or fails, the only sign is the count (9 and 7 instead of 10 and 6): the exit code is still 0.

**Optional: read the test network directly.** Set `RPC_URL` for the run. The two chain lines then move to verified (`12 verified, 0 failed, 4 not checked` with the install, `11 verified, 0 failed, 5 not checked` without it).

```
# bash, one line:
RPC_URL=https://sepolia.base.org node scripts/trust-backend-conformance.mjs

# PowerShell, two lines:
$env:RPC_URL = 'https://sepolia.base.org'
node scripts/trust-backend-conformance.mjs
```

In bash, `RPC_URL=...` on a line of its own does nothing for the next command; the chain lines stay not checked and nothing warns you. In PowerShell the variable stays set for the rest of that window, so later runs there also read the chain and their counts differ from the ones in this guide; `Remove-Item Env:RPC_URL` clears it.

The counts come from live data, so a line's wording can change (for example when the agent's score has moved since its proof was made). `0 failed` is what a healthy backend gives; a FAILED line is a finding to read, not noise. This guide records what was seen on the date above, not a promise about every later run or every agent.

**2. A rejection case.** The same run, with one answer changed in memory to what a broken backend would send:

```
node scripts/trust-backend-conformance.mjs --plant wrong-agent
```

Expected, with or without the install: a `PLANTED DEFECT` line, exit code 1, and FAILED lines. With the install there are three: `zk proof read` (the proof names another agent) and the two lines that check the proof bytes against the statement: `zk verify (this API, real proof)` and `zk verify (published verifier, run locally)`. Both print a verifier error; the output does not say why, and the reason is that the planted statement names a different agent. The third verify line, `zk verify (this API, altered statement)`, still reads VERIFIED: it reports that an altered statement was refused, which is unchanged. The last line reads like `7 verified, 3 failed, 6 not checked`. Without the install the local verifier line stays not checked, so there are two FAILED lines and the last line reads like `7 verified, 2 failed, 7 not checked`.

This does not show that a proof is tied to its agent. The check fails for this other id, but the proof format does not guarantee it fails for every other id, which is what binding would need. The `zk agent binding` line still reads NOT_CHECKED with "Agent binding not verified" in this run. Other rehearsals: `--plant altered-accepted`, `--plant simulated-receipt`.

## What each line proves

| Line | VERIFIED means | It does not mean |
|---|---|---|
| health, repid, passport, erc8004 validate | The API is up and its views of this agent agree on id, score and tier | That the score is correct: the lines show the views agree with each other, and this run cannot tell whether they share a source |
| zk proof read | A proof is published whose statement says "score >= threshold" and names this agent | Anything about the proof bytes |
| zk verify (this API, real proof) | The API's verify route accepts the proof it serves | An independent check |
| zk verify (this API, altered statement) | The same route refuses the proof when the stated score is changed by one | An independent check |
| zk verify (published verifier, run locally) | The proof bytes verify on your machine with `@hyperdag/proof-verifier` (the open-source verifier package, present only after the optional `npm ci`; without it this line is NOT_CHECKED), by a WebAssembly module running in this process, not by a request to the API, and a changed statement is refused | That the proof belongs to this agent (next line) |
| zk agent binding | Never VERIFIED today: it always prints NOT_CHECKED with "Agent binding not verified". This proof format does not tie a proof to an agent id or to the exact score and threshold, only to the difference between them, so a valid proof cannot show whose it is | |
| zk private disclosure | Never VERIFIED today: it always prints NOT_CHECKED. The score and threshold are public inputs: a validity proof, not zero-knowledge | |
| reputation on chain (as the API reports it) | The API's own account of the agent's on-chain reputation record names the same token as the passport | That the chain agrees; this line does not read the chain |
| chain readback | The ERC-8004 registry on Base Sepolia names the same owner for the agent's token as the passport | Anything about the score |
| public receipt | The latest receipt is not marked simulated and lists proofs. The line prints "real settlement"; it means "not simulated" | Real money, or which network: this line does not read the chain. The settlement evidence is on Base Sepolia, a test network (next line, with `RPC_URL`) |
| settlement on chain | The receipt's transaction exists on the chain the RPC serves (the line prints the chain id; 84532 is Base Sepolia, a test network), succeeded, and transferred the receipt's amount, in the token's base units, to the receipt's payee | A mainnet payment, or which token: the line checks the transfer, not the token contract |
| HAL (two lines, only with `--hal`) | A known-false claim is not returned clean; an unknowable claim is returned abstain or flagged | Accuracy in general: two claims are a smoke test |

The `public receipt` line ends with "run verify-trust-receipt.mjs for the hashes". That is `scripts/verify-trust-receipt.mjs`, a separate check that this guide does not cover.

Three outcomes per line: VERIFIED, NOT_CHECKED (with the reason) and FAILED. NOT_CHECKED is never a pass. Exit code 0 only when nothing failed and at least one line verified. Exit code 1: something failed. Exit code 2: nothing could be checked, or an unknown `--plant` name. Exit code 3: a `--plant` run in which nothing failed (a planted run never exits 0).

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

## For a maintainer: one check you can repeat

A separate, smaller example, using the published Inspect command against one public GitHub Actions run. It reads api.github.com only and needs no key. Run it in an empty folder; `npx` downloads the pinned public package.

Source run: https://github.com/DealAppSeo/trustshell/actions/runs/44544121933

Supported case. Put exactly this one line in a plain-text file named `claims.txt` (in PowerShell, `Set-Content -Encoding ascii claims.txt '...'`; PowerShell's `>` writes another encoding, which was not tested):

```
The check workflow succeeded on commit d9911681e9a2, run 44544121933.
```

```
npx @hyperdag/trustshell@1.9.3 check https://github.com/DealAppSeo/trustshell/actions/runs/44544121933 --claims-file claims.txt
```

`npx` may first ask to confirm the download. Expected, as observed on 2026-11-20: exit code 0, `Claims: 3 supported · 0 contradicted · 0 not checked`, and `SUPPORTED` for `commit d9911681e9a2`.

Rejection case. Change the commit in `claims.txt` to `bc549681bf05` and run the same command. Expected: exit code 1, `Claims: 1 supported · 1 contradicted · 1 not checked`, and `CONTRADICTED` for `commit bc549681bf05` ("the inspected run is on d9911681e9a2").

What it shows: GitHub's own record of that run matches, or does not match, the commit the sentence cites. The output says so itself: it is a platform record, not signed, and not a judgement that the code is correct.

Feedback we would like (one line each is enough):

1. Did both commands give the exit codes and verdicts above? If not, paste the output.
2. Which step, if any, did you have to guess?
3. Was any line of the output unclear, or stronger than what it showed?
4. Is the "What this does not prove" list missing something you expected?
5. Would you run this in your own CI as it is? If not, what stops you?
6. Your Node version and operating system.
