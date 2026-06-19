import pg from 'pg';
import { config } from 'dotenv';
config();

const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

const proofType = await c.query(`
  SELECT proof_type, is_real, count(*)::int n
  FROM repid_zkp_proofs GROUP BY 1,2 ORDER BY n DESC
`);

const june17 = await c.query(`
  SELECT count(*)::int n,
         min(id) min_id, max(id) max_id,
         count(*) FILTER (WHERE proof_type='POSTCARD')::int postcard_n
  FROM repid_zkp_proofs
  WHERE created_at >= '2026-06-17T00:00:00.000Z' AND created_at < '2026-06-18T00:00:00.000Z'
`);

const postcardReal = await c.query(`
  SELECT count(*)::int n FROM repid_zkp_proofs
  WHERE proof_type='POSTCARD' AND is_real=true AND zk_commitment IS NOT NULL
`);

console.log(JSON.stringify({ proof_type_breakdown: proofType.rows, june17: june17.rows[0], postcard_real: postcardReal.rows[0] }, null, 2));
await c.end();