# Scheduling the /health probe

`v_fleet_truth` prefers probe evidence, but only counts a probe **younger than 10 minutes**. Past
that it falls back to the weaker work-log signal and nine of twelve agents become `NULL` again.
So the probe is only useful if something runs it on a schedule.

Two ways. **Option B is cheaper and is what I would pick** — but it changes an always-on service,
so it is Sean's call.

---

## Option A — a Railway cron service (isolated, config-as-code)

`railway.health-probe.json` is committed for this. Schedule is `*/10 * * * *`, matched to the
view's 10-minute window: probing more often than the window is read is wasted spend, and less
often leaves permanent gaps.

**Exact steps (Sean-only — Railway infra is a permanent fence):**

1. Railway → **repid-engine** project (NOT AITrinitySymphony — that project runs none of this
   repo's code) → **New Service → GitHub repo → DealAppSeo/repid-engine**.
2. Service → **Settings → Config-as-code** → set the path to `railway.health-probe.json`.
3. Service → **Variables**: it needs only `SUPABASE_URL` and `SUPABASE_SECRET_KEY`. Nothing else.
   Do **not** copy the API service's full variable set — this job needs no provider keys, no
   wallet keys, and no `AGENT_KEY_MASTER`. Every extra variable on a container is leak surface.
4. Deploy. First run should log `12/12 up` and `wrote 12 probe rows`.

**Cost:** a cron spins a fresh container per run. At `*/10` that is 144 container starts/day.
Small, but not nothing, and it is the reason Option B exists.

---

## Option B — an in-process interval on the API service (free)

`src/index.ts` already runs `scoreMonitor` on a 5-minute `setInterval`. Adding the probe beside
it costs **zero** extra container starts, because the service is always on regardless.

**If you take this route it must be built properly, not just dropped in:**

- **Flag-gated, default OFF** (`HEALTH_PROBE_ENABLED`) — a new always-on loop in the API service
  is a live-state change and ships inert first.
- **Must respect the L0 halt** (`shouldParkForHalt`). LESSONS records two ungated tick loops
  found during nine days of drift, one of which moved money. A new loop that ignores the halt is
  the same defect class even though this one only reads.
- **Failures must not touch the request path.** The probe writes a row; a failed write logs and is
  swallowed, exactly like `checkAndAwardBadges`.

That work is not done. Option A works today with no code change.

---

## Either way

Run it once by hand first to confirm the environment is right — it needs no credentials at all
for the dry run:

```bash
npx ts-node scripts/liveness-probes/probe-agent-health.ts --dry-run
```

Then check the view is actually consuming the probes:

```sql
select agent_name, liveness_signal, is_live, minutes_since_probe
from v_fleet_truth order by minutes_since_probe nulls last;
```

`liveness_signal = 'probe'` on every row means it is wired. Anything falling back to `work` or
`none` means the schedule is not keeping up with the 10-minute window.
