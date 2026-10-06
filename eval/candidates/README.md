# Second-voter candidates: every trial, written down

Sean, 2026-10-06: "search for and try a couple possible replacements for Qwen, and each time we do
this we need to document the findings." This file is where they go. One row per trial, never
edited after the fact except to add a note; a re-run is a new row.

## Why qwen is the voter to replace

A label is two voters agreeing (`combineVotes`): Groq `openai/gpt-oss-120b` and Cerebras
`qwen-3.8-27b`. Replaying the stored 2026-10-05 run (`npm run eval:backtest-classify`):

- 157 of 337 claims were Not checked. **112** of those had one voter unsure, and **108** of
  the 112 were qwen.
- On those 112 rows gpt-oss's TRUE/FALSE was right 84 times (75%). So qwen's unsure is also
  blocking about 28 wrong stamps. A replacement that says TRUE/FALSE more often has to be right
  more often too, or the wrong-stamp count rises.
- 2026-10-06, live: the assumption sentence (`CLASSIFY_ASSUMPTIONS=on`) made qwen unsure on plain
  facts; same 75 rows, decided 41 → 30, wrong stamps 1 → 1 (`eval/rigorous/README.md`).

## How a trial runs

`scripts/eval/candidate-voter.ts` sends the 337 labelled claims (`eval/rigorous`) to the candidate
once, through the production voting code (same prompt, parser, timeout, per-minute budget), and
pairs each answer with Groq's stored reading. That is the label production would have given with
the candidate in qwen's seat, and it costs no Groq call. It refuses a model id the host does not
list, and it stops (to resume later) rather than record its own budget refusal as an answer.

**From a browser:** GitHub → DealAppSeo/repid-engine → Actions → `eval-candidate-voter` →
Run workflow → pick the host, paste the model id exactly as the host lists it, Run. The job
summary prints one row for the table below; paste it here with a note. The agent sandbox cannot
run it: its network policy refuses every model host.

**What the run refuses to count.** After a failed call the production voting code pauses that
model for 60 seconds. A claim refused during that pause, or over the per-minute budget, never
reached the model, so it is never recorded as the model's answer: the pause is waited out and the
claim asked again. Eight failed calls in a row stop the run, and the log prints what the host said
(HTTP status and the first 300 characters of its error, credentials redacted). A run in which the
model gave no verdict, or that stopped on failures, prints **NOT_CHECKED and no row**, and the job
goes red (exit 2).

Each host needs its key as a repository secret (Settings → Secrets and variables → Actions), under
the same name production uses. Production voter hosts: `NVIDIA_NIM_API_KEY` (evaluation use only),
`CLOUDFLARE_WORKERS_AI_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`,
`MISTRAL_API_KEY`, `TOGETHER_API_KEY`, `FIREWORKS_API_KEY`. **Eval-only hosts** (2026-10-06,
`EVAL_HOSTS` in the script; no production path calls them): `DEEPSEEK_API_KEY`, `XAI_API_KEY`,
`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `COHERE_API_KEY`, `PERPLEXITY_API_KEY`, `ASI1_API_KEY`,
`HUGGINGFACE_API_TOKEN`, and `LITELLM_URL` + `LITELLM_MASTER_KEY` for our own gateway. Without the
key the run exits 2 (NOT_CHECKED) and says which variable is missing. A production voter's own
model id (Groq gpt-oss-120b/20b, Groq qwen3.8-27b, anything on Cerebras) is refused: it would spend
production's quota.

Spending: Sean approved up to **$5 in total** for paid trials (2026-10-06). One full trial is 337
short calls (about 300 tokens in, a few out): cents on the near-free hosts. Each paid row records
its host so the running total can be checked against the cap.

**How to read a row.** Fewer wrong stamps first: a wrong stamp is the failure a user cannot see.
Coverage second. Then: can it be served in production from a host whose terms allow that (NVIDIA's
free keys cannot: "research, development, and test use only"), its median time against the
6-second stamp, its cost, and that it is a different model family from gpt-oss.

## Findings

| date | candidate | rows paired | decided: production → with candidate | wrong stamps: production → with candidate | candidate TRUE/FALSE/UNSURE/abstain | median time | notes |
|---|---|---|---|---|---|---|---|
| 2026-10-05 | `cerebras:qwen-3.8-27b` (production, the bar) | 337 | 180 (53.4%) | 6 | — | — | Stored run, flags off. 112 not-checked rows had one voter unsure, 108 of them qwen. |
| 2026-10-06 | `cerebras:qwen-3.8-27b` + `CLASSIFY_ASSUMPTIONS=on` | 75 | 41 → **30** | 1 → **1** | — | 350 ms (whole check) | Live re-run of 75 stratified rows. 12 correct stamps lost, all to qwen going unsure. Recommendation: turn the flag off. |
| 2026-10-06 | `nvidia-nim:moonshotai/kimi-k2.6` | **NOT CHECKED** | — | — | 0/0/0/337 | — | Run 37434186754. The job printed "172 → 0 decided", and that is not a measurement: the model was asked about ten times (11 minutes of 60-second pauses), every call failed (the reason was not recorded), and the 60-second pause after each failure was recorded as roughly 30 more answers. Harness fixed to wait out pauses and print the host's error; Kimi to be re-run. |
| 2026-10-06 | `nvidia-nim:moonshotai/kimi-k2.6` (re-run, fixed harness) | **NOT CHECKED** | — | — | 0 verdicts in 8 calls | — | Run 37437063265. NVIDIA answered HTTP 404 "Function … Not found for account" to every call: the id is on NVIDIA's model list but not served to this key. Unavailable, not measured. Kimi can still be tried on Workers AI or OpenRouter (no key for either in CI yet). |
| 2026-10-06 | `nvidia-nim:nvidia/nemotron-3-super-120b-a12b`, `enable_thinking: false` | 328 | 172 → **226** (52.4% → 68.9%) | 5 → **24** (false shown pass 3 → 1, true shown veto 2 → 23) | 79/253/5/0 | 271 ms | Run 37439860103. **Does not beat qwen**: more coverage, but nearly five times the wrong stamps. It answered FALSE on 253 of 337 claims, so 23 true claims would have been vetoed. 81 not-checked rows became vetoes. Not tried with thinking on (slower, and not the production setting). |

## What to measure next (research, 2026-10-06; vendor docs cited in the session, not yet measured here)

The constraint is not quality alone: a user's text goes to these hosts, so production use must be
allowed and prompts should not be trained on or kept.

- **Cerebras has no free tier any more**, and qwen-3.8-27b costs about $3 per 10,000 checks. Groq's
  free gpt-oss-120b runs out on tokens before requests (about 300 to 600 checks a day).
- **Pairs worth measuring first** (two independent families each, near-free, production-allowed):
  1. gpt-oss (OpenAI family) + **Gemini 2.5 Flash-Lite, paid tier** (Google): about $0.34 per 10k
     checks. Google's *free* tier may use prompts and have them human-reviewed, so it cannot carry a
     user's text; the paid tier does not.
  2. **Gemma 4 26B-A4B on Workers AI** (Google family) + qwen (Alibaba). Not together with pair 1:
     Gemma and Gemini are one family.
  3. gpt-oss + **Ministral 3 8B/14B** (Mistral family), paid tier with training opted out.
- **Cascade worth measuring:** two small models of different families first (e.g. Gemma 4 26B-A4B and
  Llama 3.2 3B or Granite micro on Workers AI); escalate to the full pair whenever either is UNSURE or
  they disagree. Logged, never trusted, until its agreement with the full pair is measured on these
  claims: two weak models confidently agreeing on a wrong answer is the failure to catch.
- **Routing:** self-hosted LiteLLM with one model group per family, each falling back only within its
  family (gpt-oss: Groq → Workers AI → Cerebras). A fallback that crosses families makes both votes
  one family's and nothing reports it.
- Not candidates: GitHub Models (retired 2026-07-30); Cohere trial keys and NVIDIA free keys (not for
  production); xAI's large free credit (only with data sharing on); You.com (no chat API: search
  only, a possible evidence source for the "established records" idea below).

## Queue (NOT CHECKED: nothing below has been run yet)

Model ids change; copy the id from the host's own list at run time. The harness refuses one the
host does not list. Availability was read from public pages on 2026-10-06 and is itself a claim
to re-check.

| candidate | evaluate on | could serve production from | cost / terms to check |
|---|---|---|---|
| Nemotron 3 Super (NVIDIA) | `nvidia-nim` | to find: a host whose terms allow production | NIM key is evaluation-only |
| Kimi K2 (Moonshot) | `nvidia-nim` | Workers AI (already our account), Groq (preview) | Workers AI neurons are shared with the Llama checker |
| MiniMax M2.7 | `nvidia-nim` | paid hosts only | needs `SEAN_PAID_LOOP` before any production use |
| DeepSeek V4 Flash | `nvidia-nim` | Workers AI | as Kimi |
| Gemma 4 (Google) | `nvidia-nim` or `workers-ai` | Workers AI | the free OpenRouter Gemma fails our canary today (rate-limited) |
| Mistral Small 3.1 | `workers-ai` | Workers AI | as Kimi |
| Muse Spark 1.3 (Meta) | `openrouter` | OpenRouter, Meta Model API | paid; the cheap "contributor" tier's data terms must be read before a user's text goes there |
| MiMo (Xiaomi) | `openrouter` | Xiaomi API, DeepInfra, Novita | paid only |

Sources for the table: Meta's [Muse Spark 1.3 page](https://developer.meta.com/ai/models/muse-spark/)
and [OpenRouter listing](https://openrouter.ai/meta/muse-spark-1.3-contributor);
[NVIDIA API catalog](https://build.nvidia.com/nvidia); [Groq models](https://console.groq.com/docs/models);
[Workers AI models](https://developers.cloudflare.com/workers-ai/models/);
[DeepInfra on MiMo](https://deepinfra.com/blog/best-mimo-v2-5-api-providers).

## Not a voter yet: evidence from well-established records

Sean, 2026-10-06: "considering running GraphRAG in parallel and searching for similar answers or
contrarian perspectives already well established and recorded."

The cases the two voters miss together are mostly famous ones (a myth both models learned, a
puzzle with a well-known wrong answer). Those are exactly the cases that are already written down:
curated misconception lists, published fact-checks (ClaimReview), encyclopaedia corrections. So a
retrieval step could hand the voters the established record before they answer, or flag "this
matches a recorded misconception" as evidence beside the stamp.

What it would take, and what would make the measurement honest:

- **Start with plain retrieval over a curated local corpus, not a full GraphRAG build.** GraphRAG's
  graph and community summaries help with questions about a whole corpus. One claim against known
  records is a nearest-match lookup. A local index also sends a user's text nowhere new.
- **An outside fact-check API is a new destination** for a user's text. It needs the privacy page
  and Sean's GO in the same change, like every checker before it.
- **Leakage will flatter it.** Our canary and TruthfulQA rows are built from the same misconception
  lists such a corpus would hold. Measure on rows the corpus could not have contained (FEVER,
  HaluEval, new claims written after the index), and report the overlapping rows apart.
- **It can only add evidence or withhold a pass.** A retrieved match never turns a miss into a
  pass on its own: a miss is never a pass.
