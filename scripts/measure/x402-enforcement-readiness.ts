/**
 * x402 enforcement readiness — READ ONLY.
 *
 * Answers the one question flipping `X402_ENFORCEMENT_ENABLED` needs answered
 * first: **how many contracts would the cascade have refused to escrow?**
 *
 * The gate is real and it is on the money path. `processCascadeQueue`
 * (`src/index.ts`) moves `service_contracts` from `pending` to `escrowed` every
 * 60s — a financial state transition that is default-ON with no flag of its own.
 * With `X402_ENFORCEMENT_ENABLED=true` it adds one predicate:
 *
 *     .not('x402_payment_id', 'is', null)
 *
 * so a contract with no payment id is never escrowed. This script applies that
 * exact predicate to the live table and reports what it would have changed.
 *
 *   npx ts-node scripts/measure/x402-enforcement-readiness.ts          # table
 *   npx ts-node scripts/measure/x402-enforcement-readiness.ts --json   # JSON
 *
 * THREE OUTCOMES. Exit 0 VERIFIED, 2 NOT_CHECKED, 1 FAILED. NOT_CHECKED never
 * shares an exit code with success — the whole reason this repo writes scripts
 * this way is that a 12-day outage was NOT_CHECKED scored as FAILED in the one
 * place it moves real money.
 *
 * WHAT THIS CANNOT TELL YOU, stated rather than implied: whether the flag is
 * currently SET. That is a Railway variable, not a database fact. An attempt to
 * infer it from the five `pending` rows fails — every one of them had already
 * EXPIRED, so the cascade skipped them for expiry and their being unescrowed is
 * evidence of nothing. Read the service's Variables to close it.
 */
import { db } from '../../src/db';

const EXIT = { VERIFIED: 0, FAILED: 1, NOT_CHECKED: 2 } as const;

interface Readiness {
  /** Contracts the cascade could act on RIGHT NOW (pending + unexpired). */
  eligible_now: number;
  /** Of those, how many enforcement would refuse (no payment id). */
  would_refuse_now: number;
  /** Reached escrowed-or-beyond carrying no payment id — retrospective only. */
  historical_no_payment: number;
  /** Same, but created in the last 30 days: the number that predicts today. */
  recent_no_payment_30d: number;
  total_contracts: number;
  measured_at: string;
}

async function measure(): Promise<Readiness | null> {
  const nowIso = new Date().toISOString();

  const { data, error } = await db
    .from('service_contracts')
    .select('status, x402_payment_id, expires_at, created_at');
  if (error || !data) return null;

  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  // "Escrowed or beyond" — a contract that got past the gate. `pending`,
  // `cancelled` and `disputed` never cleared it, so counting them as refusals
  // would overstate the impact of turning enforcement on.
  const PAST_GATE = new Set(['escrowed', 'fulfilled', 'satisfied', 'settled', 'resolved']);

  let eligible = 0;
  let refuse = 0;
  let hist = 0;
  let recent = 0;

  for (const c of data as Array<Record<string, unknown>>) {
    const noPayment = c['x402_payment_id'] == null;
    const status = String(c['status'] ?? '');
    const expires = c['expires_at'] ? String(c['expires_at']) : null;

    // The cascade's own predicate: pending AND not yet expired.
    if (status === 'pending' && expires !== null && expires > nowIso) {
      eligible += 1;
      if (noPayment) refuse += 1;
    }
    if (PAST_GATE.has(status) && noPayment) {
      hist += 1;
      if (c['created_at'] && Date.parse(String(c['created_at'])) > cutoff) recent += 1;
    }
  }

  return {
    eligible_now: eligible,
    would_refuse_now: refuse,
    historical_no_payment: hist,
    recent_no_payment_30d: recent,
    total_contracts: data.length,
    measured_at: nowIso,
  };
}

async function main(): Promise<void> {
  const json = process.argv.includes('--json');
  const r = await measure();

  if (r === null) {
    // A read that did not happen is NOT_CHECKED. It must not look like "zero
    // contracts would be refused", which is what exit 0 with empty output says.
    const out = { verdict: 'NOT_CHECKED', reason: 'could not read service_contracts' };
    console.log(json ? JSON.stringify(out, null, 2) : 'NOT_CHECKED — could not read service_contracts.');
    process.exit(EXIT.NOT_CHECKED);
  }

  if (json) {
    console.log(JSON.stringify({ verdict: 'VERIFIED', ...r }, null, 2));
    process.exit(EXIT.VERIFIED);
  }

  console.log('# x402 enforcement readiness\n');
  console.log('| question | answer |');
  console.log('|---|---|');
  console.log(`| contracts the cascade could act on now (pending, unexpired) | ${r.eligible_now} |`);
  console.log(`| **of those, enforcement would REFUSE** | **${r.would_refuse_now}** |`);
  console.log(`| got past the gate historically with no payment id | ${r.historical_no_payment} |`);
  console.log(`| ...of those, created in the last 30 days | ${r.recent_no_payment_30d} |`);
  console.log(`| contracts, all statuses | ${r.total_contracts} |`);
  console.log(`\nmeasured_at ${r.measured_at}`);
  console.log('\nNOT CHECKED: whether X402_ENFORCEMENT_ENABLED is currently set. That is a');
  console.log('Railway variable, not a database fact, and it cannot be inferred from the');
  console.log('pending rows — they had all expired, so the cascade skipped them for expiry.');
  process.exit(EXIT.VERIFIED);
}

main().catch((e) => {
  console.error('FAILED —', e instanceof Error ? e.message : String(e));
  process.exit(EXIT.FAILED);
});
