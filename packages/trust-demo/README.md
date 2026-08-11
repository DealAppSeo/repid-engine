# @hyperdag/trust-demo

**Trust math, not a server.** One command, no API key, no account, no build step.

```bash
npx @hyperdag/trust-demo
```

You will watch a genuine Plonky3 STARK proof verify **on your own machine**, and then watch
the same verifier reject three tampered versions of it. Then the command reads four live
production surfaces over keyless HTTP.

Measured **~65 ms** wall clock for all four verifications, including Node startup, on an
x86_64 container (5 runs: 62–70 ms). Your machine will differ; the point is that it is
fast enough that there is no reason not to check.

## Why the first step is the important one

Most "verifiable" demos ask you to believe a server that says `verified: true`. This one
runs the published [`@hyperdag/proof-verifier`](https://www.npmjs.com/package/@hyperdag/proof-verifier)
WASM locally, offline, over a real proof:

```
1. A real STARK proof, verified on YOUR machine (offline, no key)
   OK    proof VERIFIED locally by @hyperdag/proof-verifier v0.2.0 (10673 bytes)
   OK    tamper rejected: score changed
   OK    tamper rejected: agent_id swapped
   OK    tamper rejected: threshold raised above the score
```

The tamper cases are not decoration. A verifier that accepted everything would also accept
the honest case, so the honest case alone proves nothing. Rejecting a swapped `agent_id` is
what shows the proof is **bound to that agent** and cannot be replayed by another.

This step needs no network. Run it on a plane:

```bash
npx @hyperdag/trust-demo --offline
```

## What else it checks

| Step | What | Needs a key? |
|---|---|---|
| 1 | A real STARK proof verified locally, plus three tamper rejections | no — and no network |
| 2 | The agent's live RepID score and tier | no |
| 3 | That agent's **live** proof, fetched then verified locally | no |
| 4 | The Base Sepolia attestation anchor | no |
| 5 | The newest real settled exchange, with a shareable receipt URL | no |
| 6 | HAL's cross-provider hallucination quorum | **yes** — opt-in |

## HAL is opt-in, and that is deliberate

HAL is the only leg that needs a key: keyless callers hit `HAL_PUBLIC_RATE_LIMIT` and get a
429. If it ran by default, most first runs would end on a rate-limit gap that says nothing
about the system. So it runs when you have a key, and otherwise reports that it was **not
consulted**.

```bash
REPID_API_KEY=… npx @hyperdag/trust-demo   # runs the quorum
npx @hyperdag/trust-demo --hal             # try keyless and watch the cap for yourself
```

"Not consulted" is not "passed", and the summary keeps the two apart — every run ends with
one of three sentences depending on whether HAL was skipped, attempted-and-unanswered, or
actually answered. None of them is ever an authorisation verdict.

The `halScore` this prints is **raw and uncalibrated** — it is not a probability. On the
frozen holdout, cases scoring 0.50 were hallucinations 83–88% of the time. The calibrated
figure needs the frozen calibrator artefact, which lives in the repo and is deliberately not
vendored here (it would drift silently); for that number with its ruler attached, run
`scripts/demo/trust-harness-e2e.mjs`.

## Options

```
--offline           only the local proof check; makes no network calls
--agent <slug>      which agent to look up (default: trinity-shofet)
--claim "<text>"    the statement HAL scores (default: a deliberately false one)
--hal               consult HAL even without a key (expect the per-IP cap)
--engine <url>      point at a different deployment
--json              machine-readable output, same data
--timeout <ms>      per-request timeout (default 15000)
--send-key-to-custom-engine
                    allow REPID_API_KEY to be sent to a non-official --engine
```

## Security properties

This is a tool whose entire claim is "believe your own machine". Two things follow, and
both are enforced by tests rather than intention.

**The server cannot draw on your terminal.** Every value that comes off the network is
stripped of ANSI escape sequences and control characters before it is printed, and bounded
in length. Without that, a hostile or compromised engine could return cursor-movement
sequences that erase a red `FAIL` the client had already printed and repaint it as a green
`OK` — defeating the whole argument invisibly, while the cryptography stayed correct. If an
engine tries it, the run says so explicitly rather than quietly cleaning up after it.

**Your API key goes to the official engine and nowhere else.** `--engine` retargets the
CLI, so `REPID_API_KEY=… npx @hyperdag/trust-demo --engine https://evil.example` would
otherwise hand your key to a stranger. The token is only sent to the official origin unless
you pass `--send-key-to-custom-engine` for a host that is genuinely yours; otherwise it is
withheld and the run tells you it was withheld. Comparison is on URL origin, not a prefix —
`…up.railway.app.evil.com` does not pass.

Beyond that: the package writes no files, executes nothing it downloads, and has exactly
one dependency (pure WASM, no transitive dependencies, `npm audit` clean).

Exit codes: `0` every attempted leg passed · `1` a leg that ran produced a failure (for
example a proof was rejected) · `2` nothing could be checked at all.

## What it will not do

**It never invents a value.** Every step either produces a real result from a real system
or prints `????` with the reason. If production is unreachable you get four named gaps and
a proof that still verified locally — not a green tick.

**It is not an authorisation verdict.** Even with HAL consulted, the dual-auth gate also
needs the owner standards hash and the progressive fold, which come from the Rust Poseidon2
binary. An unavailable safety check is not a passing safety check, so this command never
prints a gate decision. The full harness lives in `scripts/demo/trust-harness-e2e.mjs`.

**The bundled proof is synthetic, deliberately.** `fixtures/leaf-rangecheck.synthetic.*` is
a real STARK proof generated offline over a fabricated witness (a NIL-variant UUID, a
made-up score). It is not a production extract. Live agent data is fetched at runtime,
never embedded in this package.

## What a `verified: true` actually means

Verbatim from the verifier's own README, because overclaiming here would defeat the point:

- **Agent-bound.** A proof minted for agent A fails under any other `agent_id`.
- **Range-sound.** The circuit proves `repid_score > threshold` via a 16-bit range check on
  the gap, so `repid_score ≤ threshold` has no satisfying witness.
- **Value-bound.** An AIR boundary constraint ties the range-checked gap to the public
  `{threshold, repid_score}`.

And what it does **not** mean: the score is *public*, not hidden — this is a verifiable
attestation, not zero-knowledge concealment. There is no timestamp, so it carries no "had
RepID X at time T" claim. And it does not re-verify the server's upstream RepID computation.

## Requirements

Node 18+. Verified on **Node 18.20.8** and **Node 22.22.2**, running the packed tarball
both offline and against a live engine. One dependency (`@hyperdag/proof-verifier`), pure
WASM with no dependencies of its own.

## Licence

Apache-2.0
