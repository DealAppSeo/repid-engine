# RepID has two scoring paths and the live one is not the documented one

**Date:** 2026-08-02 · **Author:** CC · **Status:** DECISION REQUIRED (Sean)
**All figures below were measured against prod, not inferred.**

---

## 1. The finding

`src/engine/repid-update.ts::updateRepId` is the pipeline CLAUDE.md documents as canonical —
10 ordered steps including decay, redemption, ecosystem-need weighting and badge awards.

**It has written zero score events in 30 days.**

Proof: `updateRepId` writes `metadata.mode`, `metadata.constitutionalAudit` and
`metadata.deltaComputed` on *every* event, unconditionally.

```
repid_score_events, last 30 days .............. 35,501
  carrying metadata.mode ......................      0
  carrying metadata.constitutionalAudit .......      0
  carrying metadata.deltaComputed .............      0
  carrying metadata.decayApplied ..............      0
```

The live writers are `src/scoring/pipeline.ts` (`runScoreEvent`, `applyValidationEvent`) and
`src/services/validation-repid-delta.ts`. Both write `repid_score_events` and update
`repid_agents.current_repid` directly. Neither calls `updateRepId`. Neither references decay.
`pipeline.ts`'s own header calls itself "the canonical history".

This is not a dormant cron. `repid-decay-weekly` being offline is a symptom.

---

## 2. What is actually dormant

Everything only `updateRepId` does:

| Layer | Consequence of it not running |
|---|---|
| **Decay** (`layers/decay.ts`) | Idle agents never lose score. RepID only ratchets up. |
| **Redemption modifier** | Punishments are never dampened for prosocial agents. |
| **Ecosystem-need weight** | `repid_ecosystem_supply` multiplier never applied. |
| **Badge awards** | `checkAndAwardBadges` never fires — `repid_badges` is not growing from events. |
| **Constitutional audit** | Never invoked. (Already flagged non-load-bearing, so consistent.) |
| **Supply-rate counters** | `updateSupplyRate` never bumps. |

### 2.1 And a concrete divergence, not just absence

| | documented (`updateRepId:503`) | live (`pipeline.ts:648`) |
|---|---|---|
| clamp | `Math.max(10, Math.min(10000, …))` | `Math.max(0, …)` — floor 0, **no ceiling** |

The database saves us: `repid_agents_current_repid_check CHECK (current_repid >= 10 AND <= 10000)`.

But it saves us the *wrong way*. On the documented path a large negative delta **clamps to 10**. On
the live path it computes e.g. 4, attempts the write, and the constraint **rejects it (23514)** — so
the score does not update at all. A penalty large enough to matter is the penalty most likely to be
silently dropped. Same at the top: an agent at 9,990 taking +30 fails to write rather than capping
at 10,000.

I have not found evidence of this firing in the ledger, but it is reachable from the live path today.

---

## 3. Why it matters right now

Every RepID number on the surfaces built today — the service manifest, the TrustBadge that embeds on
third-party sites, `/llms.txt`, the leaderboard — comes from the path that skips decay. With ~104
"active" agents and roughly 12 doing real work (see the roster note), scores only go up.

The badge presents those numbers as a **track record** on somebody else's website.

---

## 4. The three options

### Option A — Make `pipeline.ts` canonical. Retire `updateRepId`.
Accept the live behaviour as intended. Delete or archive `updateRepId`, fix the clamp to
`[10, 10000]`, and update CLAUDE.md so the docs describe reality.

- **Cost:** decay, redemption, ecosystem-need and badges are *gone* as features, not deferred. Say so
  publicly rather than leaving them documented.
- **Risk:** none to live data. Highest honesty, lowest ambition.
- **Best if:** those four layers were aspirational and nobody misses them.

### Option B — Route everything back through `updateRepId`.
Make the live writers call it. Restores all six layers at once.

- **Cost:** ⚠ **the one-time decay shock.** Decay is computed from 30-day activity, so the first event
  after the switch applies up to 30+ days of absent decay in a single step, per agent, across the
  whole roster. That is a live RepID event on every agent simultaneously — visible on-chain via
  ERC-8004 writes and on every badge.
- **Risk:** highest. Also the largest refactor, on the money-adjacent path.
- **Mitigation if chosen:** run it in shadow first (compute the delta, write it to a shadow column,
  change nothing), read the distribution, *then* decide whether to apply it gradually or at once.
  Do not flip this one blind.

### Option C — Port the layers into `pipeline.ts` one at a time.
Leave the live path as the writer; add decay, then redemption, then the rest, each behind its own
flag and each measured in shadow before enforce.

- **Cost:** slowest. Duplicates logic unless the layers are extracted to shared modules first
  (the same "one computation, many renderers" move used for the manifest and badge).
- **Risk:** lowest per step, and each step is independently reversible.
- **Best if:** the layers are wanted but the shock in B is unacceptable.

---

## 5. What I would do, stated as a recommendation not a decision

**C, with the clamp fixed immediately and separately.**

The clamp is not a design question — `Math.max(0, …)` against a `>= 10` CHECK is a latent
silently-dropped-penalty bug on the live path regardless of which option wins. That should be a
small standalone PR either way.

Then decay in shadow first, because the decay shock in B is the kind of thing that is obvious in
hindsight and expensive in public: badges and on-chain reputation writes would all move at once, and
"our scores dropped because we turned a feature on" is a hard sentence to publish on a trust product.

**What I am NOT recommending:** picking between A and C on my own. Whether decay, redemption and
ecosystem-need are *wanted* is an economic design question about what RepID means. That is yours.

---

## 6. If you pick nothing

The status quo is not neutral. It is Option A **without saying so** — the layers stay documented,
undelivered, and cited in specs, while the badge publishes decay-free scores as track record. That is
the one outcome with no defence.

---

*Measured 2026-08-02: 35,501 events / 30d, zero from the documented path. Clamp divergence confirmed
in source; DB CHECK confirmed in prod.*
