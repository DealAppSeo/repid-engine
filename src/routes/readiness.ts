// src/routes/readiness.ts
//
// GET /readiness — keyless, uncached, and it names the build it is describing.
//
// The reasoning for the whole surface, including why these flags are safe to
// publish and why `ignored_value` is its own word, lives in
// `src/config/flag-readiness.ts`. This file is the transport.
//
// ── WHY IT CARRIES `deployed_commit` ────────────────────────────────────────
//
// A flag report with no commit on it is ambiguous for exactly as long as a
// deploy takes, and that is precisely when someone reads it: they have just
// changed a variable and want to know whether it took. Railway keeps the last
// SUCCESSFUL build serving when a new one fails (see routes/health.ts), so
// "I saved the variable and the endpoint still says off" has two completely
// different causes — the value is wrong, or the process holding the old value is
// still the one answering. The commit tells them which, and it is the same field
// `/health` already exposes, read the same way.
//
// ── WHY IT IS NOT CACHED ────────────────────────────────────────────────────
//
// `/health` caches for 5 s because it dials Supabase and a chain RPC. This
// reads `process.env` and nothing else, so a cache would buy nothing and cost
// the one property that matters: a person watching for a restart to take effect
// must not be shown a stale answer. `no-store` for the same reason
// `app/api/version/route.ts` sets it in the trinity repo — `www` was caught
// serving `x-vercel-cache: HIT` on exactly this kind of route.
//
// Flags are read at MODULE SCOPE by their gates (`byok.ts:139`,
// `human-agent-binding.ts:35`), i.e. once per process. This route reads
// `process.env` per request instead, deliberately: if the two ever disagree, the
// process is running a value the environment no longer holds and has not been
// restarted. `restart_required` reports that rather than hiding it — a
// module-scope read here would have made this endpoint agree with the stale
// gates and report the very staleness it exists to expose.

import { Router, Request, Response } from 'express';
import { describeFlagReadiness, PUBLIC_FLAGS, TRUTHY } from '../config/flag-readiness';

const router = Router();

// Same resolution as routes/health.ts — Railway injects RAILWAY_GIT_COMMIT_SHA
// at build time for GitHub-linked services. Constant for the life of a deploy.
const DEPLOYED_COMMIT: string =
  process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || 'unknown';

/**
 * The boot-time value of each flag, latched HERE rather than imported from the
 * gates that own them.
 *
 * The obvious version imports `HUMAN_AGENT_BIND_ENABLED` from
 * `services/human-agent-binding`, which reads better and is wrong: that module
 * pulls in `ethers` and `../db`, and `src/config.ts` throws without its
 * variables. A readiness endpoint that cannot answer when configuration is
 * broken is useless precisely when it is needed, so this file imports nothing
 * that can fail. It also means the endpoint stays testable without mocking a
 * database, which is how the test below drives every branch.
 *
 * WHAT IT ASSUMES, stated rather than glossed: this module is imported during
 * app construction, same as the gates, so it latches the same values they
 * latched. That holds because nothing in this codebase mutates `process.env`
 * between imports. If something ever does, this reports the gates as stale when
 * they are not — a false alarm, never a false all-clear, which is the correct
 * direction for the failure to point.
 */
const LATCHED_AT_BOOT: Record<string, boolean> = Object.fromEntries(
  PUBLIC_FLAGS.map((f) => [f.name, process.env[f.name] === TRUTHY])
);

router.get('/readiness', (_req: Request, res: Response) => {
  const { flags, misconfigured } = describeFlagReadiness(process.env);

  // A flag whose live env value no longer matches the value its gate latched at
  // boot. The gate wins until the process restarts, so this is the honest
  // "you changed it and it has not taken effect yet" signal.
  const restartRequired = Object.entries(LATCHED_AT_BOOT)
    .filter(([name, latched]) => (flags[name] === 'on') !== latched)
    .map(([name]) => name);

  res.set('Cache-Control', 'no-store');
  res.json({
    flags,
    misconfigured,
    restart_required: restartRequired,
    deployed_commit: DEPLOYED_COMMIT,
    deployed_commit_short:
      DEPLOYED_COMMIT === 'unknown' ? 'unknown' : DEPLOYED_COMMIT.slice(0, 7),
    checked_at: new Date().toISOString(),
    note:
      'Status words only, from a fixed allowlist — never values. `off` means unset; ' +
      '`ignored_value` means set to something other than the exact string "true", which ' +
      'every gate in this engine requires, so the feature is OFF while the dashboard shows ' +
      'it populated.',
  });
});

export default router;
