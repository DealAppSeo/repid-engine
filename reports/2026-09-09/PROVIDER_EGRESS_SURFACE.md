# Provider egress: what `LOCAL_LLM_BASE_URL` covers, and the 26 files it does not

Dated snapshot, 2026-09-09. Outcomes are reported three ways: **VERIFIED** /
**NOT CHECKED** / **FAILED**.

**This report is a measurement, not a status page.** Everything below is true *as
of its date* and stays true — a dated finding cannot rot, which is why the
convention here is `reports/<date>/` rather than a living document. Where a claim
would go stale, it is marked NOT CHECKED and names the observation that would
close it.

Landed as: [#695](https://github.com/DealAppSeo/repid-engine/pull/695) (the
doc corrections, squashed as `62664f7`) and
[#696](https://github.com/DealAppSeo/repid-engine/pull/696) (the guard, squashed
as `43b6372`). Neither changes runtime behaviour. Both SHAs are on `main` — the
claims below are checkable against the tree, not only against this file.

---

## 1. The finding, and the four times it was understated

The question was narrow: *who receives the NVIDIA NIM key?* Answering it walked a
chain, and **each answer was still too reassuring.**

| what `CLAUDE.md` said | what was measured | gap |
|---|---|---|
| a gateway "changes who sees the **prompt**" | it sends that host your **API keys** | wrong category |
| your whole provider **keyring** | true of the **fact-check quorum only** | wrong scope |
| "a **second** production path" ignores the redirect | **26 files** name provider hosts | wrong by 25 |

Three corrections in one night, each closer, **each drifting toward comfort.**
That direction is the point. Prose describing a boundary does not decay randomly —
it decays toward the reassuring reading, because the reassuring reading is the one
nobody re-checks.

### The mechanism, VERIFIED

`src/hal/fact-check.ts` rewrites `p.endpoint` under the redirect and leaves
`p.apiKey` **untouched**; `queryProvider` then sends
`Authorization: Bearer <that provider's key>` to whatever the new endpoint is.
**The key follows the endpoint.**

Measured by building the quorum with one distinct fake key per provider and
`LOCAL_LLM_BASE_URL` set:

```
providers built: 10 | pointed at the gateway: 10
distinct credentials handed to it: fake-NVIDIA fake-deepseek fake-fireworks
  fake-gemini fake-gloo fake-groq fake-mistral fake-openrouter fake-qwen fake-zai
not redirected: (none)
[hal] quorum: dropping anthropic under LOCAL_LLM_BASE_URL — its anthropic wire format …
```

Ten is a **floor**: cerebras was absent only because its own dead-model skip had
already dropped it. Anthropic-dialect members are **dropped rather than
redirected**, so their key does not travel — the one exception, and it exists
because of a wire-format incompatibility, not a security decision.

### Why "a second path" was still wrong

`src/services/adversarial-judge.ts` carries its own provider list with **six
hardcoded endpoints**, reads the same `GROQ_API_KEY` / `OPENAI_API_KEY` /
`DEEPSEEK_API_KEY` / `CEREBRAS_API_KEY`, and references `resolveProviderEndpoint`
or `LOCAL_LLM_BASE_URL` **zero times**. Three production callers plus a daily
12:00Z cron.

Then the sweep: **26 files under `src/` name a provider host.** The judge is one
of twenty-six.

---

## 2. The reusable lesson: a negative control that controlled nothing

`provider_health` holds a daily `anthropic` row. Anthropic-dialect providers are
**dropped** under a local base. So that row reads as proof the variable was unset —
a clean negative control.

**It is not.** The row comes from the judge, which hardcodes `api.anthropic.com`
and would have succeeded whether the variable was set or not.

> **A negative control only controls if the code path you are reading actually
> passes through the mechanism.** Check that first, before the result means
> anything.

This inference was built and killed before publication. Had it shipped, the file
would now carry a confident, dated, wrong claim about a production variable — the
`plonky3-stub` failure exactly, in a different subsystem.

---

## 3. The guard, and the bug in its first version

`tests/provider-egress-guard.test.ts` re-derives the surface on every run and
compares it to a committed baseline. **It is an inventory, not a chokepoint.**

### The design bug, caught in review

The first version failed whenever **any** listed file stopped matching, and called
it "list rot". But a callsite that stops naming a host **because it now goes
through the registry is progress** — the exact outcome the guard exists to drive.
The check could not tell a cleanup from a stale label, so **the guard punished its
own goal.**

Found by Grok reading the committed test. Corrected before the split PR went up.

### Four roles, measured not assumed

One flat list cannot express that *may know a hostname* and *may present a bearer*
are different permissions.

| role | n | why |
|---|---|---|
| `ADAPTERS` | 10 | `src/providers/*` — naming its own host **is** the job |
| `PROBES` | 1 | dials providers to test credentials; names hosts **and** sends bearers |
| `NOISE` | 2 | host appears in a **comment** only — where the superset matcher shows |
| `CALLSITES` | **13** | business logic that reached for a provider directly |

**TARGET: `CALLSITES` → 0.** The other three are allowed to stay.

### The ratchet, which is what makes the target real

A header comment saying `TARGET: 0` enforces nothing. `CALLSITE_CEILING` may only
ever be **lowered**, giving two independent locks:

- a new direct caller fails the **NEW-file** check
- adding it to `CALLSITES` to silence that fails the **ratchet**

The first version's *"add it with a reason"* honour system could not prevent
exactly that — **and its own comment claimed it could.**

### Non-vacuity, proven by breaking it

```
callsite stops matching            → "…is PROGRESS — delete the line and lower the ceiling"
adapter stops matching             → "…is rot — it moved or was deleted"
14th callsite, ceiling untouched   → "the ratchet holds"
all reverted                       → 7 passed
```

Each lands on a differently named test. Same mechanism, opposite meaning.

**A note on verifying the verification:** the first non-vacuity run grepped for a
symbol jest does not emit here, so all three induced failures printed nothing and
nearly read as success. A check that cannot fail is the same defect as a guard
that cannot fail — it just moves one level up.

---

## 4. What this does NOT establish

**Layer 1 of three.** Hostname presence is a **superset** of "makes a call" —
noisy beats silently blind — and it does not detect:

- a host assembled at runtime from parts
- `new OpenAI({ apiKey })` and friends, where the SDK embeds its own base URL
- a proxy hop

All **NOT CHECKED**. **Knowing a URL is not presenting a bearer.** A green run
here is not the chokepoint existing.

The remaining layers, both still with no runtime change:

2. an import-graph guard on SDK constructors outside `src/providers/` and a future
   `src/sealer/`
3. `src/egress/provider-fetch.ts` as the named chokepoint — named *before* anyone
   calls it, so adapters do not each grow a private `fetch` while waiting

No claim is made that any of the 26 is wrong. Most are legitimate adapters. The
guard makes them **countable**, which turns *"every provider call goes through one
chokepoint"* from an aspiration into something CI can refuse.

---

## 5. Still NOT CHECKED

**Whether `LOCAL_LLM_BASE_URL` or `OPENAI_BASE_URL` is set on any Railway
service.** Four read paths were tried and all are dead: `/health` does not expose
it, the only env-presence surface (`admin-flags.ts`) is auth-gated and covers named
feature flags, no table logs endpoints, and reading Railway variables needs
credentials this session did not have.

**The observation that closes it:** the `repid-engine` service's Variables tab,
filtered for `LOCAL_LLM` and `OPENAI_BASE`. Names only. If either is set, the
ten-credential handover above is live rather than hypothetical.

A second, related trap worth writing down while it is fresh: Anthropic's workload
identity federation is real and GA, but **`ANTHROPIC_API_KEY` or
`ANTHROPIC_AUTH_TOKEN` left set — even set to empty — silently outranks it.** You
migrate, everything works, and the long-lived key is still what authenticates.
Any future chokepoint must **assert which credential source actually resolved**
rather than assert that federation is configured.

---

## 6. Scope note

This report covers the **egress findings only** — what lives in this repository and
is verifiable against its code. The capability-broker design work from the same
session (standing policy / Grant / token objects, and the decision to reject
steganography as a confidentiality layer) is **deliberately not here**: it belongs
with the product it describes, not in the engine, and putting it here would make
this repo a second home for a design that already has one.
