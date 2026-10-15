/**
 * MEASUREMENT ISOLATION: a HAL measurement run writes nothing to production unless it is told to.
 *
 * WHY (CC1 smoke, 2026-10-15, reports E:\dev\reports\2026-10-15\CC1_HAL_SMOKE_2026-10-15.md).
 * run-frozen-corpus-local.ts loads the real key inventory and calls halService in-process. With
 * that inventory loaded, the HAL path:
 *   - inserts one prod `llm_call_log` row per provider call (src/billing/log-call.ts, through `db`);
 *   - bumps the shared Dragonfly provider-health counters that live HAL routes on
 *     (src/cache/provider-health.ts, whenever REDIS_URL is set);
 *   - on an extractor fallback, writes `ops_alerts` and the audit chain, and PAGES SEAN on Telegram
 *     (src/lib/degraded.ts → src/services/operator-pager.ts).
 * A measurement is not production traffic. Its calls are not the product's calls, and a dead-key run
 * must not page anyone at 3am.
 *
 * WHAT THIS DOES. It must be the FIRST import of the runner, ahead of dotenv and of any module that
 * reads config at import time (src/config.ts computes LOCAL_MODE when it loads). Unless the argv
 * holds --write-prod it sets:
 *   LOCAL_MODE=true      `db` becomes the local SQLite store (src/db.ts, src/selfhost/local-store.ts)
 *   LOCAL_STORE_PATH     a short path under the OS temp dir. SQLite cannot open a deeper path on
 *                        Windows, and a failure to open must not send writes anywhere else.
 *   REDIS_URL=''         Dragonfly is a no-op (src/cache/dragonfly.ts cacheEnabled)
 *   TELEGRAM_*=''        the pager is not armed and cannot push
 * dotenv never overrides a variable that is already set, so the key file loaded afterwards cannot
 * undo any of this.
 *
 * WHAT IT DOES NOT CHANGE. Provider calls still go to the providers; that is the measurement. The
 * ground-truth gate now reads the local store, which is empty, so it cannot fire. The run output
 * records that, because it is part of the ruler. Reads of the private holdout
 * (scripts/eval/holdout.ts) use their own client and are reads, not writes.
 */
import os from 'os';
import path from 'path';

export const WRITE_PROD_FLAG = '--write-prod';

export interface Isolation {
  mode: 'local' | 'prod';
  /** Where `db` writes go in local mode. */
  store: string | null;
  redis: 'off' | 'from-env';
  telegram: 'off' | 'from-env';
  /** What the ground-truth gate can see. Part of the ruler. */
  ground_truth: 'local-store (empty)' | 'production';
}

/** Applies the isolation to `env` (process.env by default) and says what it did. */
export function applyIsolation(argv: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Isolation {
  if (argv.includes(WRITE_PROD_FLAG)) {
    return { mode: 'prod', store: null, redis: 'from-env', telegram: 'from-env', ground_truth: 'production' };
  }
  const store = env.HAL_EVAL_LOCAL_STORE?.trim() || path.join(os.tmpdir(), 'hal-eval-local', 'store.db');
  env.LOCAL_MODE = 'true';
  env.LOCAL_STORE_PATH = store;
  env.REDIS_URL = '';
  env.TELEGRAM_BOT_TOKEN = '';
  env.TELEGRAM_OWNER_CHAT_ID = '';
  return { mode: 'local', store, redis: 'off', telegram: 'off', ground_truth: 'local-store (empty)' };
}

/** The one line printed at the top of every run, so the mode is never a guess. */
export function isolationBanner(i: Isolation): string {
  return i.mode === 'local'
    ? `ISOLATION  : LOCAL (default). DB writes (llm_call_log, ops_alerts, audit) -> ${i.store} on this machine. ` +
        `Dragonfly counters OFF. Telegram pages OFF. Ground-truth gate sees an empty local store. ` +
        `Pass ${WRITE_PROD_FLAG} to write to production.`
    : `ISOLATION  : PROD (${WRITE_PROD_FLAG}). llm_call_log, ops_alerts, provider-health counters and Telegram pages ` +
        `go to PRODUCTION exactly as live HAL traffic does.`;
}

export const ISOLATION: Isolation = applyIsolation();
