# Checked-answer demo: an opinion is not a check

Three made-up cases, one command. It shows the difference between a model panel's **opinion** of an AI's reply and an **independent check** of the AI's decision against an answer key.

Fixture replay. No model is called. No key, no network, no database. Nothing is written, so no reputation score moves. Benchmark-style result: experimental.

## Run it

Working directory: the repository root. Node 20.9 or newer (written and run on Node 22.17).

It needs the repository's dependencies once (`ts-node` runs the TypeScript directly):

```
npm ci --legacy-peer-deps
```

That installs the whole engine's dependency tree, not one package. Clean installs by other readers took 24 to 40 minutes [reported]; yours may be much faster. There is no route that skips the install: the jest test below needs the same one. If you would rather not install, the full output is printed further down this page.

Then, the same line in bash and in Windows PowerShell 5.1:

```
npx ts-node --transpile-only scripts/demo/checked-answer-demo.ts
```

It takes about 6 to 12 seconds (run in both shells on 2026-11-20). Add `--json` for the same data as JSON, or `--verbose` to also see the lines the panel code logged.

In Windows PowerShell 5.1 a successful run also shows one block of red text that begins `node.exe : [family-registry] EXCLUDED 1 ambiguous seed entry`. It is not a failure. The engine code prints one notice on the error stream when it loads, and PowerShell 5.1 colours anything on that stream red and wraps it as an error record. The three cases, the table and `RESULT:` are on the normal output, and the exit code is still 0 (check with `$LASTEXITCODE`). To hide the notice, add `2>$null` to the end of the line. In bash the same notice is a single plain line.

Exit code 0 means all three cases gave the expected outcome, the database stand-in was never called and no network call was attempted. Anything else is non-zero.

The same checks as a test:

```
npx jest --config jest.config.js tests/checked-answer-demo.test.ts
```

## The three cases

| Case | What the AI did | Panel opinion on the reply | Answer key | Outcome |
|---|---|---|---|---|
| A | Right decision, true reason | clean | match | CHECKED: CORRECT |
| B | **Wrong decision**, but its one-line reason reads as true | clean | mismatch | CHECKED: WRONG |
| C | A decision on a task nobody holds a key for | clean | none available | NOT CHECKED |

Case B is the point. The panel is handed the reply text only, and asked whether that text is factually true. "The Great Wall of China is thousands of kilometres long" is true, so the panel says clean. The decision it supports is wrong, and only the comparison with the key shows it.

Case C is the other half. With no key, the panel's opinion is the only signal, and the demo says NOT CHECKED. That is not a pass. This demo also prints NOT CHECKED when the AI abstains; that is the demo's wording. The engine's grader scores an abstain against a key as 0 and records it.

## Expected output

```
--- Case A ---
Task: Is this statement true? Answer pass (true) or veto (false): "Water boils at 100 degrees Celsius at sea-level pressure."
AI answered: pass (confidence 0.9). Reason: "At standard sea-level pressure the boiling point of water is 100 degrees Celsius."
Panel opinion on the reply: clean (members said TRUE, TRUE, TRUE).
  Note: the panel saw only the reply, not the task or the key.
Independent check: answer key: match
OUTCOME: CHECKED: CORRECT
RepID change in this demo: 0 (nothing is written)

--- Case B ---
Task: Is this statement true? Answer pass (true) or veto (false): "The Great Wall of China can be seen with the naked eye from the Moon."
AI answered: pass (confidence 0.8). Reason: "The Great Wall of China is thousands of kilometres long."
Panel opinion on the reply: clean (members said TRUE, TRUE, TRUE).
  Note: the panel saw only the reply, not the task or the key.
Independent check: answer key: mismatch
OUTCOME: CHECKED: WRONG
RepID change in this demo: 0 (nothing is written)

--- Case C ---
Task: Is this statement true? Answer pass (true) or veto (false): "The minutes of the made-up Tuesday meeting record that the budget was approved."
AI answered: pass (confidence 0.7). Reason: "Meeting minutes usually record budget approvals."
Panel opinion on the reply: clean (members said TRUE, UNCERTAIN, TRUE).
  Note: the panel saw only the reply, not the task or the key.
Independent check: answer key: none available. Nothing independent verified the work. Not a pass.
OUTCOME: NOT CHECKED
RepID change in this demo: 0 (nothing is written)

Case | Panel opinion | Answer key     | Outcome
A    | clean         | match          | CHECKED: CORRECT
B    | clean         | mismatch       | CHECKED: WRONG
C    | clean         | none available | NOT CHECKED

Database calls: 0. Network calls refused: 0. Fixture panel answers served: 9.
RESULT: all three cases gave the expected outcome.
```

The order of the three member answers inside the brackets can differ between runs. One line about a model-family registry may appear on the error stream when the code loads; it is not part of the result.

## What is real code and what is fixture

| Part | Real or fixture |
|---|---|
| Turning three member answers into the panel's decision word | Real: `factCheck` in `src/hal/fact-check.ts` (the request it builds, the parsing, the aggregation) |
| Reading the decision out of the reply and comparing it with the key | Real: `parseKnownAnswer` and the `ka-v2-precommitted` scorer in `src/services/experimental-repid.ts` |
| The tasks, the replies, the answer keys | Fixture: made up, typed in the script |
| What each of the three panel members answers | Fixture: typed in the script. `fetch` is replaced by a guard that serves them for one made-up address and refuses every other host |
| The database client and the provider-call log | Replaced by a recorder that counts calls. The count must be 0 |

## Privacy

Everything stays on this machine. In a live run, a model provider would receive the reply text (not the task, not the key). The output keeps only the lines shown.

## What it does not show

- No live model. The member answers are typed, so this says nothing about how often a real panel is right.
- No reputation write. The key grader used here writes, in the engine, only to a separate table labelled experimental; in this demo it writes nowhere.
- No on-chain step, no proof, no payment. Testnet or mainnet is not relevant here.
- Not the deployed configuration. The demo switches off the panel's extra steps (the ground-truth lookup, the shadow second opinion, retrieval, escalation) so the decision comes from the three typed answers alone. A deployed run may have some of them on.
- Not a measurement. Three hand-written cases illustrate a mechanism; they are not a benchmark.

## Where to go next

- `docs/TRUST_BACKEND_PREVIEW.md`: the keyless conformance run against the public endpoints.
- The published Inspect command, in the same guide under "For a maintainer: one check you can repeat".
