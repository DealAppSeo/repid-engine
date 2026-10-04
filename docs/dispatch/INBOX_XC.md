# INBOX_XC: red-team PR #1185 (B21 T12 loopback job, B20 hardening, ?with=id)

## Task

**Lane:** RED-TEAM. You have **no write scope**: the deliverable is text. Do not claim to have
created, edited or committed a file. You hold `reasoning` and `repo_read`, scoped to THIS
workspace, which is PR #1185's branch. **Three outcomes: VERIFIED / NOT_CHECKED / FAILED.**
Dispatched by CC2 (Claude) on 2026-10-04 from the hourly heartbeat, during Sean's overnight sprint.

### What changed since your B20 FIX FIRST on #1182

1. `src/classify/free-votes.ts`:
   - `encodeClaim` (NFKC fold, strip `\p{Cf}` and control characters, JSON-string framing)
     replaces the `<claim>` tag strip.
   - `activeVoters`: Groq gpt-oss-120b plus Cerebras qwen-3.8-27b when a Cerebras key is
     present, otherwise Groq x2.
   - `BUDGET_PER_MIN` per voter (Groq 24, Cerebras 4, NVIDIA 32).
2. `src/routes/repid.ts`: `GET /repid/:id?with=id` adds the resolved `agent_id`. The default
   body stays `{score, tier}`.
3. `.github/workflows/t12-loopback.yml` and `src/orchestration/t12-runner-job.ts`: Ollama inside
   the runner, `T12_FREE_WAVE` on for one step, no secrets, a labelled claim set through `t12Ask`.
4. `.github/workflows/build-loop-cloud.yml`: the loop no longer opens report-only PRs.

### Deliverable

Rank by failure direction, false pass first. For each finding give the input, the file:line you
read, and the jest test that would catch it. At minimum, try:
- Does anything still reach the model outside the JSON string? Look at the system prompt
  assumptions, NFKC side effects (could folding turn a harmless claim into a different claim?),
  and surrogate pairs.
- Can the per-minute budget be gamed? The bucket is in memory and per process: what happens
  across restarts or several instances?
- `?with=id`: can it leak anything beyond an id `/proof` already exposes? Unknown names, the
  NOT_CHECKED path, and timing.
- The T12 workflow: input interpolation of `inputs.model` into shell (Strix ruled it out as
  write-access-only; agree or disagree?), and anything that could make the receipt claim `local`
  when a cloud host answered.

One verdict line: **MERGE / FIX FIRST / HOLD**, with the single most important reason.
