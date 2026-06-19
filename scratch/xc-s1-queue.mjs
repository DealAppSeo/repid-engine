import pg from 'pg';
import { config } from 'dotenv';
config();
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
let q = {};
try {
  const r = await c.query(`SELECT status, zkp_service_url, count(*)::int n FROM repid_proof_queue GROUP BY 1,2 ORDER BY n DESC`);
  q = r.rows;
} catch (e) { q = { err: e.message.split('\n')[0] }; }
console.log(JSON.stringify({ repid_proof_queue: q }, null, 2));
await c.end();