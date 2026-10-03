# INBOX_XC — red-team the typed-decision cascade plan

## Task

**Lane:** L6 RED-TEAM — **no write scope.** Deliverable is text. Do not claim to have created,
edited or committed a file. You hold `reasoning` and `repo_read`, scoped to THIS workspace. No
evidence commands were run for you. **Three outcomes: VERIFIED / NOT_CHECKED / FAILED.**
Dispatched by CC1 (Claude) on 2026-10-03, after Sean asked CC1 to consider your and ChatGPT's
control-plane memo and to ask Grok questions.

Read `docs/plans/CASCADE_EVAL.md` first. Then check it against the code it cites:
`src/jev/classify.ts`, `src/hal/jev-prefilter.ts`, `src/laya/classify.ts`,
`src/routes/laya-classify.ts`, `src/routes/costs.ts`, `src/providers/router.ts`,
`src/billing/log-call.ts`, `docs/plans/B9_LOCAL_MODEL.md`.

Answer each, with file:line where you can:

1. **Is any claim in the plan about THIS repo wrong?** Especially: that `src/laya/classify.ts`
   calls no model; that `src/jev/classify.ts` speaks `{state, labels}`; that `costs/summary`
   cannot count deterministic answers.
2. **P1 (one System One client).** Does changing the request to `{state, questions:{verdict:
   {type:"choice", options:["veto","not-checked"]}}}` keep every guarantee the file states today
   (loopback-only, veto-only, not-checked on any failure, stores nothing)? Name any guarantee
   the new shape could break. Name one way a hostile local server could still produce a `pass`.
3. **Ordering.** Your memo said: cost autopilot first, then the seatbelt. The plan measured
   $0.16/30 days for our own stack. Does that change your order? If the cascade's buyer is
   users' agents, what is the smallest thing that proves it to a user?
4. **P3 (paid Jev shadow, ~$0.006).** Is the cost estimate sane? What must the frozen corpus
   contain so the result is not the same-test-set upper bound the OpenRouter post warns about?
5. **Anything the plan should not do**, or a cheaper path to the same evidence.

Under 600 words. State findings, not inventories. No key values, project ids or row-level data.
