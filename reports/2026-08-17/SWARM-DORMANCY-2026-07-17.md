# Trinity swarm dormancy — what actually stopped on 2026-07-17

Written 2026-08-17. Every timestamp below was queried, not inferred. The one inference is
labelled as such. Read the NOT ESTABLISHED section before repeating any of this as cause.

## The short version

The swarm did not fail silently for lack of a detector. **The detector worked.** It caught the
outage within ten minutes, wrote the correct diagnosis, and has repeated it roughly 1,300 times a
day for thirty days into a table that nothing reads. The gap was never detection. It was delivery.

A second correction, which matters more than the first: **"the swarm is dead" is wrong.** Three
agent processes are running right now. What died on 17 July was the heartbeat write, and every
downstream reader — the liveness endpoint included — infers death from heartbeat staleness.

## Timeline (VERIFIED)

| When (UTC) | What |
| :--- | :--- |
| through 2026-07-16 04:00 | steady state, ~185 task claims/hour, 11 agents claiming |
| **2026-07-16 ~05:00** | step change down to ~60 claims/hour. Sustained, not a dip. All 11 agents still present and claiming |
| 2026-07-16 → 07-17 | holds at the degraded rate for ~41 hours |
| **2026-07-17 22:18:09 → 22:18:57** | all 12 heartbeats stop inside a **48-second window** |
| 2026-07-17 22:28 | first `survivor_alert`, 10 minutes after the stop — the detector fires correctly |
| 2026-07-18 onward | task claims fall to 0–6/day and stay there |
| **2026-08-17 07:40** | most recent `survivor_alert` — still firing today |

Two events, not one. The 16 July degradation and the 17 July stop are separated by 41 hours and
have to be explained separately. Anything that explains only the stop is incomplete.

## What is still alive

`trinity-torch`, `trinity-shofet` and `trinity-veritas` each wrote 420–450 alerts in the last 24
hours. Their own heartbeat rows still read `last_ping = 2026-07-17 22:18`.

So these three processes are simultaneously:
- running, looping, and writing to the database every few minutes
- recorded as `status: "online"` in a row that has not been touched in a month
- reported as `state: "dead"` by the liveness endpoint

**The proof that these are processes and not ghosts is mutual alerting.** At 22:28 veritas wrote
"trinity-torch is DOWN". At 22:31 torch wrote "trinity-veritas is DOWN". A dead process cannot
write a row. Both were alive and each was reading the other's stale heartbeat. `DOWN` in these
alerts means *heartbeat stale*, never *process gone* — and no reader of that word has ever made
the distinction.

## The alert nobody received

Every one of the ~40,000 alerts carries its own remedy:

```
🚨 SURVIVOR ALERT: trinity-gcm is DOWN
⏱️ Time Down: 10 minutes
🛠️ Action: Manual redeploy required. Autonomous redeploy disabled.
```

The instruction is correct and it is addressed to a human who was never told. Autonomous redeploy
is off by design, so **nothing in this system will self-heal.** It will keep alerting until
someone redeploys, and the alert channel terminates in a database table.

## trinity-mel — a separate, older fault

Do not fold this into the outage. `trinity-mel` shows 19,155 loops with **0 completed** and 2
failed, against ~4,380 loops and ~1,500–2,100 completed for its peers. It was burning four times
the loops for zero output *before* 17 July, and it never claims tasks at all. Different fault,
different fix.

## NOT ESTABLISHED — do not fill these in by inference

- **Root cause of the 2026-07-16 degradation.** Unknown.
- **Root cause of the 2026-07-17 heartbeat stop.** Unknown.
- **Whether the other nine processes are alive.** No evidence either way. They write nothing,
  which is not the same as being gone — three agents also write nothing to the heartbeat while
  demonstrably running.

Three things that are *not* the cause, checked and cleared:

- No error rows anywhere in the window. The whole failure logged **zero** errors.
- No deployment events recorded for 14–20 July.
- `emergency_halt` is false. It was toggled and restored on **27 July**, ten days *after* the
  stop, so it cannot be the trigger.

The absence of error rows is itself the most useful signal: whatever stopped the heartbeat did
not go through any code path that reports failure.

## For whoever picks this up

1. Recovery needs a human. Manual redeploy, per the alert's own instruction.
2. Diagnose the 16 July degradation and the 17 July stop as two problems.
3. Treat `trinity-mel` separately.
4. The alert path needs a consumer that is not a database table, or the next outage repeats this
   one exactly.
