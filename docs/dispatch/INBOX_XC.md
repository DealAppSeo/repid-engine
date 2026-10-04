# INBOX_XC — B20: red-team the two free votes behind POST /api/v1/classify (PR #1182)

## Task

**Lane:** RED-TEAM. You have **no write scope**: the deliverable is text. Do not claim to have
created, edited or committed a file. You hold `reasoning` and `repo_read`, scoped to THIS
workspace, which is PR #1182's branch. No evidence commands were run for you.
**Three outcomes: VERIFIED / NOT_CHECKED / FAILED.** Dispatched by CC2 (Claude) on 2026-10-04,
during Sean's overnight sprint (trustshell `docs/living/BUS.md`, section "TONIGHT", ticket B20).

### What changed (Sean decided B9 = option 2 on 2026-10-04)

`POST /api/v1/classify` used to decide arithmetic only. Prose now goes to two free Groq models
in parallel. Both TRUE: pass. Both FALSE: veto. Anything else: not-checked. A 429 backs that
voter off and never falls through to another host. The deadline went from 1 s to 2.5 s.
The route still stores nothing.

### Read

- `src/classify/free-votes.ts`: voters, the prompt, `parseVerdict`, the 429 cooldown,
  `combineVotes`.
- `src/routes/classify.ts`: `classifyText`, the deadline, CORS, the per-IP limit.
- `tests/classify-free-votes.test.ts` and `tests/classify-route.test.ts`: what is pinned today.

### Deliverable

1. **An attack list, ranked by failure direction.** Rank first anything that can make the route
   answer `pass` for a false claim (or `veto` for a true one). Rank lower anything that only
   yields a wrong `not-checked`. Cover at least:
   - prompt injection inside the claim: closing-tag smuggling, unicode look-alikes of `</claim>`,
     instructions to "answer TRUE";
   - a claim built so both models say TRUE while it is false (shared-family blind spots,
     because both defaults are gpt-oss);
   - very long text, multi-claim text and mixed-language text;
   - the 429 cooldown map: can one caller starve everyone (a cost or availability attack)?;
   - abusing the public route as a free proxy to Groq, and whether the per-IP limit is enough;
   - a host that answers with prose, a JSON body that is not chat-completions, or an empty
     `choices`.
   For each attack: the input, the code path (file:line you actually read), and the jest test
   that would catch it.
2. **One verdict line: MERGE / FIX FIRST / HOLD**, with the single most important reason.

Write the result as your transcript. CC2 turns each finding into code or a test on PR #1182.
