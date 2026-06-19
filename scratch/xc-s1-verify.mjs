import pg from 'pg';
import { config } from 'dotenv';
config();

const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

const cols = await c.query(`
  SELECT column_name FROM information_schema.columns
  WHERE table_name = 'repid_zkp_proofs' ORDER BY ordinal_position
`);

const scheme = await c.query(`
  SELECT COALESCE(scheme,'(null)') scheme,
         count(*)::bigint n,
         count(*) FILTER (WHERE proof_bytes IS NOT NULL AND octet_length(proof_bytes) > 0)::bigint with_bytes,
         max(created_at) max_created
  FROM repid_zkp_proofs GROUP BY 1 ORDER BY n DESC
`);

const isReal = await c.query(`
  SELECT
    count(*) FILTER (WHERE is_real = true)::int real_n,
    count(*) FILTER (WHERE is_real IS NOT TRUE)::int stub_n,
    count(*)::int total
  FROM repid_zkp_proofs
`);

const hasEasUid = cols.rows.some((r) => r.column_name === 'eas_attestation_uid');
const easCol = hasEasUid ? 'eas_attestation_uid' : 'NULL::text';

const anchored = await c.query(`
  SELECT
    count(*) FILTER (WHERE ${hasEasUid ? 'eas_attestation_uid' : 'false'} IS NOT NULL)::int anchored,
    count(*) FILTER (WHERE merkle_root IS NOT NULL AND (${hasEasUid ? 'eas_attestation_uid' : 'NULL'}) IS NULL)::int merkle_no_uid,
    count(*) FILTER (WHERE merkle_root IS NULL)::int no_merkle
  FROM repid_zkp_proofs
`);

const realSample = await c.query(`
  SELECT id, scheme, octet_length(proof_bytes) bytes, is_real,
         merkle_root IS NOT NULL has_merkle,
         ${easCol} eas_col, created_at
  FROM repid_zkp_proofs
  WHERE is_real = true ORDER BY created_at DESC LIMIT 5
`);

const stubRecent = await c.query(`
  SELECT max(created_at) max_stub FROM repid_zkp_proofs WHERE is_real IS NOT TRUE
`);

// zkp queue if exists
let queue = { err: null };
try {
  queue = (await c.query(`SELECT status, count(*)::int n FROM zkp_proof_queue GROUP BY 1 ORDER BY n DESC`)).rows;
} catch (e) {
  queue = { err: e.message.split('\n')[0] };
}

const rpc = 'https://sepolia.base.org';
const attester = '0x4F8AD3fB35473b6DEA0559FfbbDe034e2Db504fb';
let attesterRpc = {};
try {
  const bal = await fetch(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_getBalance', params: [attester, 'latest'], id: 1 }) });
  const nonce = await fetch(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_getTransactionCount', params: [attester, 'latest'], id: 2 }) });
  const bj = await bal.json();
  const nj = await nonce.json();
  attesterRpc = { balance_wei: bj.result, nonce: parseInt(nj.result || '0', 16) };
} catch (e) {
  attesterRpc = { error: e.message };
}

console.log(JSON.stringify({
  at: new Date().toISOString(),
  repid_zkp_proofs_columns: cols.rows.map((r) => r.column_name),
  scheme_breakdown: scheme.rows,
  is_real_counts: isReal.rows[0],
  anchor_state: anchored.rows[0],
  real_sample: realSample.rows,
  stub_max_created: stubRecent.rows[0],
  zkp_queue: queue,
  attester: attesterRpc,
}, null, 2));
await c.end();