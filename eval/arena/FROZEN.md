# Frozen L0 arena evaluator (XC1)

Spec: `E:\dev\sprints\2026-10-20\AUTONOMY_LOOPS_SPEC.md` §7. "The case list is frozen by XC1; CC1 may not
edit XC1's oracle." These files are that freeze. The builder lane (CC1) does not edit anything in this
folder, and does not edit `scripts/e2e-local/arena/oracle.ts` either: the test below pins it to the copy
here.

| file | what it is |
|---|---|
| `oracle.ts` | the 18 cases, `predict` and `grade`. A byte-identical copy of `scripts/e2e-local/arena/oracle.ts` at PR #1452 head `ae7f131a`, reviewed by XC1 and frozen as is. Its sha256 is the `evaluator_sha256` every arena evidence record already carries. |
| `cases.json` | the case list, the controls, the five pass conditions and the red-team variant classes |
| `variants.ts` | the red-team variant schema a free model fills, its strict validator, and the deterministic grader. It restates spec §2-§4 independently of the arena's `guard.ts`, and adds checks `grade` lacks (the buyer's own outflow, the decoy for every party, a cited settlement that is not this NPA's payment). Pure. |
| `run-variants.ts` | executes validated variants against the arena executor (unmodified) and grades them with `variants.ts`. No model call, no key. |
| `seal.mjs` | rewrites `manifest.json`; `--check` exits 1 on drift |
| `manifest.json` | sha256 of each file above. Its own sha256 is the commitment |

Commitment: `tests/eval/arena-oracle-frozen.test.ts` pins `EXPECTED_MANIFEST_SHA256`. That test also fails
when `scripts/e2e-local/arena/oracle.ts` (if present) differs from `oracle.ts` here, line endings
normalised. So an edit to the grader by anyone but XC1 turns CI red.

Changing the evaluator: XC1 only, in its own PR, with the reason, `node eval/arena/seal.mjs`, and the new
manifest sha256 in the test and the PR description. Records graded before and after carry different
`evaluator_sha256` values and are never compared as one series.

Unsigned. Sean may sign the manifest sha256 in a detached `manifest.sig.json`; nothing verifies it yet.
Not family-independent: XC1 runs on Claude, as CC1 does. It is separated by lane, not by model family.
