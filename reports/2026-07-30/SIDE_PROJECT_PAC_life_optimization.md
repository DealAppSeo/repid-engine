# PAC — Personal Assistant Coach (voice-first life-optimization capture)
**Logged:** 2026-07-30 · **Source:** Sean · **Status:** IDEA — logged for further dev · **Candidate for:** next hackathon (~week of 2026-08-03) · **Cross-link when E: is mounted:** `living-docs/SIDE_PROJECTS.md`

## The idea (Sean's framing, preserved)
A voice-first app the user talks to on their phone like Siri/Alexa, but the assistant is **named by the user at setup** — "Hey Bro," "Hey Babe," "Hey Cal," "Hey <anything>." One spoken sentence makes a timestamped digital note of anything relevant, especially **things that are cause-and-effect, or are *perceived* as cause-and-effect**:

> "just took my vitamins" · "feeling good" · "just worked out" · "feeling down" · "feeling inspired" · "feeling broken"

Over time these if-then events, thoughts, and feelings are tracked and **accurately calibrated** to surface the life hacks that actually work *for that person* — helping them reach a state of flow where their strengths, passions, and abilities align, while mitigating weaknesses, hurts, and hang-ups; and helping them move through fear toward faith, hope, and love.

**Stated purpose:** level up a person's life in the most meaningful, eternal way possible — *to help the last, the lost, and the least.*

## Why this is the same primitive we built today (the non-obvious connection)
The RepID calibration ledger scores an agent on: *you claimed X with confidence Y — was it true when independently resolved?* PAC does exactly that **for a human's beliefs about their own life**: *you believe vitamins → feeling good; does your own logged data support it?*

Direct reuse of concepts (not necessarily code):
- **Proper scoring rules** — score the user's *predicted* effect against the *observed* one. Calibration, not agreement. A user who predicts "workout → good day" and is right 80% of the time has a validated hack; one who's right 45% has a belief.
- **Evidence hierarchy (L2)** — passive sensor data (sleep, steps, HR) outranks self-report, exactly as execution outranks opinion.
- **The un-farmable floor** — self-report alone is Tier-D evidence; it can *propose* a hack, never *confirm* one.
- **Fail loud** — "not enough data to say" must be a first-class, visible answer. Never a confident correlation from n=4.
- **Absence-neutrality** — a missed log day is not evidence of anything.

**The most valuable feature is probably disconfirmation.** Everyone has a private theory of what helps them. Showing someone, from their own data, that a believed cause *isn't* supported — and that an unnoticed one *is* — is the thing no journaling app does. That's the same "consensus is suspicious" instinct that makes HAL different.

## Hard problems (be honest up front)
1. **n-of-1 causal inference is genuinely hard.** Confounders, reverse causality ("I worked out *because* I already felt good"), placebo, regression to the mean, weekday effects, seasonality. The rigorous form is n-of-1 trial design (randomized/alternating interventions), which most users won't do — so v1 should say "associated with," never "causes," and reserve causal language for the cases where the user opts into a real A/B.
2. **Custom wake word is the hardest *engineering* piece, not the fun one.** Always-on custom wake-word detection needs an on-device engine (e.g. Porcupine-class) plus battery/permission work. **Hackathon path:** ride the platform assistant — an iOS Shortcut / Android equivalent triggered by a user-chosen phrase — so "Hey Siri, tell Cal…" works day one. Build true custom wake word only if the demo demands it.
3. **Friction is the product.** If capture takes more than ~3 seconds, the data never accumulates. One utterance → one row. No forms, no categories at capture time (classify later, server-side).
4. **This is intimate data.** Mood, health, spiritual state. Local-first or E2E-encrypted by default; explicit export/delete; never a third-party routing input. Treat privacy as the architecture, not a setting.
5. **Regulatory line.** Not a medical device, no diagnosis, no treatment claims. Wellness-and-insight framing only; the honesty rails discipline applies here more than anywhere.

## Sketch of v1 (hackathon-sized)
- **Capture:** one utterance → `{ts, raw_text, inferred_type: event|state|feeling, tags[], sentiment}`. Classification happens after capture, never during.
- **Timeline:** plain chronological review + edit (trust requires the user seeing their raw data).
- **Insight pass (batch, not real-time):** lagged association between event-type X and state Y within a window; report effect size **with confidence bounds** and an explicit n. Below a data floor: "not enough signal yet" — the fail-loud rule.
- **Nudge loop:** surface only *validated* associations, ranked by effect size × the user's stated priority.
- **Optional rigor mode:** the app proposes a two-week alternating test of one hack — real n-of-1, opt-in.

## Naming/positioning notes
"PAC — Personal Assistant Coach," user-named at setup, is a genuinely good hook: naming the assistant is the onboarding moment that creates attachment, and it's the one thing the big assistants structurally can't offer. Same thesis as the agent-layer flip: **the relationship lives with the user's agent, not the platform's model.**

## Next steps when picked up
1. Decide platform path (Shortcut-triggered vs. custom wake word) — determines the whole build budget.
2. Define the minimum event taxonomy (start with ~10 types; let free text carry the rest).
3. Write the insight-pass statistics *before* the UI, including the data floor and the "not enough signal" state.
4. Privacy architecture decision (local-first vs. E2E cloud) before any storage code.
