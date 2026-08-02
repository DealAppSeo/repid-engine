# Round 2 — cross red-team

**Send only after BOTH round-1 designs are in.** Give each model the *other's* design, never its
own. The point is attacking work you have no stake in.

Paste the other model's full round-1 answer, then this:

---

## Your job

Above is a competing design for TrustMarket.dev, produced independently from the same brief you
answered. You are not reviewing it. You are trying to break it.

**Default to finding something.** Agreeing costs you nothing and tells us nothing. If you conclude
it is sound, you have most likely not looked hard enough at the part you find least interesting.
We would rather read a wrong attack we can dismiss than a polite endorsement we cannot use.

Do not defend your own design, do not compare the two, and do not declare a winner. Only this one,
only its failure modes.

## Attack these in order

**1. The growth loops — hardest, do this first.**
For each loop it proposes, answer concretely:
- What does it look like on **day one, at 7 settled contracts and 0 human listings**? Not at
  scale — at the real current numbers.
- Who performs the first action, and what do they get before anyone else shows up? If the reward
  requires other participants, the loop does not start, it only sustains.
- What is the **cheapest way to fake the signal** the loop runs on? Assume a motivated bad actor
  with 50 wallets and an LLM.

**2. Where honesty quietly dies.**
The brief forbids fabricated social proof. Growth design routinely smuggles it back in as
manufactured scarcity, vanity counters, "N people viewing", implied activity, seeded content
presented as organic, or engagement numbers that measure nothing. **Find every place this design
does that**, including places the author almost certainly did not intend. Quote the specific
element.

**3. The unexamined assumption.**
Every design rests on one belief about human behaviour that it never argues for. Name this one's.
State what would have to be true for it to hold, and give the cheapest test that would falsify it.

**4. Cost of being wrong.**
Which single decision in this design is most expensive to reverse six months in? Not hardest to
build — hardest to *undo*.

**5. The strongest thing in it.**
One paragraph, and be genuinely specific. If a design has no strongest thing, say that instead —
but only if you mean it.

## Format

Numbered to match the five headings. For each attack: what breaks, the concrete scenario in which
it breaks, and how severe that is. No preamble, no summary at the end.

Where you think the original brief itself set a bad constraint and this design merely inherited it,
say so and mark it clearly as a brief problem rather than a design problem — that is our mistake to
fix, not theirs.
