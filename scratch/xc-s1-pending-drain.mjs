import pg from 'pg';
import { config } from 'dotenv';
config();

const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

const pending = await c.query(`
  SELECT count(*)::int n FROM repid_zkp_proofs
  WHERE is_real IS NOT TRUE AND merkle_root IS NULL
`);

const realUnanchored = await c.query(`
  SELECT count(*)::int n FROM repid_zkp_proofs
  WHERE is_real = true AND merkle_root IS NULL AND eas_attestation_uid IS NULL
`);

const realDistinct = await c.query(`
  SELECT count(DISTINCT zk_commitment)::int n FROM repid_zkp_proofs WHERE is_real = true
`);

const minMaxReal = await c.query(`
  SELECT min(id)::int min_id, max(id)::int max_id FROM repid_zkp_proofs WHERE is_real = true
`);

const rlsBefore = await c.query(`
  SELECT c.relname, c.relrowsecurity,
         (SELECT count(*)::int FROM pg_policies p WHERE p.tablename = c.relname) policy_n
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname IN (
    'service_contracts','x402_payment_gates','x402_settlements',
    'staking_deposits','staking_withdrawals','repid_score_events',
    'trinity_task_audit_log','tool_call_log'
  ) ORDER BY 1
`);

const counts = {};
for (const t of ['service_contracts','x402_payment_gates','x402_settlements','staking_deposits','staking_withdrawals','repid_score_events','trinity_task_audit_log','tool_call_log']) {
  try {
    const r = await c.query(`SELECT count(*)::int n FROM ${t}`);
    counts[t] = r.rows[0].n;
  } catch (e) {
    counts[t] = { err: e.message.split('\n')[0] };
  }
}

console.log(JSON.stringify({ pending_stubs: pending.rows[0], real_unanchored: realUnanchored.rows[0], real_distinct_commitments: realDistinct.rows[0], real_id_range: minMaxReal.rows[0], rls_before: rlsBefore.rows, table_counts: counts }, null, 2));
await c.end();