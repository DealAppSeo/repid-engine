/**
 * eligibility-bench.ts — the utility bench's two non-ZK baselines (spec §12). The same decision, "RepID >= T
 * for this task", made two ways. The ZK row comes from `cargo run --release --example eligibility_bench`
 * in zkp-vault; the report puts the three side by side with one ruler.
 *
 *   (a) disclosed: the engine signs {agent_id, score, epoch}; the verifier checks score >= T itself.
 *   (b) predicate: the engine signs {agent_id, "score_gte", T, epoch}; the verifier checks T against its policy.
 * Both add holder binding: the agent signs the verifier's challenge with its own key, else a presentation could
 * be replayed by anyone who saw it. Ed25519 from node:crypto (no new dependency).
 *
 *   npx ts-node --transpile-only scripts/zkp/eligibility-bench.ts [iterations]
 * Prints one JSON object. Latencies are medians over `iterations` (default 2000) after a warm-up.
 */
import { generateKeyPairSync, sign, verify, randomBytes, KeyObject } from 'node:crypto';

type Row = { approach: string; verifier_learns: string[]; issue_us: number; present_us: number; verify_us: number; bytes: number; heap_kb: number };

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };
const time = (n: number, f: () => void) => {
  for (let i = 0; i < 50; i++) f();
  const t: number[] = [];
  for (let i = 0; i < n; i++) { const a = process.hrtime.bigint(); f(); t.push(Number(process.hrtime.bigint() - a) / 1e3); }
  return median(t);
};

const engine = generateKeyPairSync('ed25519');
const agent = generateKeyPairSync('ed25519');
const T = 500, EPOCH = 20409, SCORE = 742, AGENT = 'agent-7f3c';

// ---- the integration code a verifier writes (counted for the "integration lines" column) ----
// BEGIN verify-disclosed
function verifyDisclosed(p: Pres, challenge: Buffer, enginePub: KeyObject, threshold: number, epochNow: number): boolean {
  const c = JSON.parse(p.credential.toString());
  if (!verify(null, p.credential, enginePub, p.engineSig)) return false;
  if (c.epoch < epochNow - 1 || c.score < threshold) return false;
  return verify(null, Buffer.concat([challenge, p.credential]), c.agent_pub_pem && toKey(c.agent_pub_pem), p.holderSig);
}
// END verify-disclosed
// BEGIN verify-predicate
function verifyPredicate(p: Pres, challenge: Buffer, enginePub: KeyObject, threshold: number, epochNow: number): boolean {
  const c = JSON.parse(p.credential.toString());
  if (!verify(null, p.credential, enginePub, p.engineSig)) return false;
  if (c.predicate !== 'score_gte' || c.threshold !== threshold || c.epoch < epochNow - 1) return false;
  return verify(null, Buffer.concat([challenge, p.credential]), toKey(c.agent_pub_pem), p.holderSig);
}
// END verify-predicate

type Pres = { credential: Buffer; engineSig: Buffer; holderSig: Buffer };
const agentPem = agent.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const keyCache = new Map<string, KeyObject>();
function toKey(pem: string): KeyObject {
  let k = keyCache.get(pem);
  if (!k) { k = require('node:crypto').createPublicKey(pem) as KeyObject; keyCache.set(pem, k); }
  return k;
}

function run(kind: 'disclosed' | 'predicate', n: number): Row {
  const body = kind === 'disclosed'
    ? { agent_id: AGENT, agent_pub_pem: agentPem, score: SCORE, epoch: EPOCH }
    : { agent_id: AGENT, agent_pub_pem: agentPem, predicate: 'score_gte', threshold: T, epoch: EPOCH };
  let credential = Buffer.alloc(0), engineSig = Buffer.alloc(0);
  const issue_us = time(n, () => { credential = Buffer.from(JSON.stringify(body)); engineSig = sign(null, credential, engine.privateKey); });
  const challenge = randomBytes(32);
  let p: Pres = { credential, engineSig, holderSig: Buffer.alloc(0) };
  const present_us = time(n, () => { p = { credential, engineSig, holderSig: sign(null, Buffer.concat([challenge, credential]), agent.privateKey) }; });
  const f = kind === 'disclosed' ? verifyDisclosed : verifyPredicate;
  if (!f(p, challenge, engine.publicKey, T, EPOCH)) throw new Error(`${kind}: honest presentation rejected`);
  if (f(p, randomBytes(32), engine.publicKey, T, EPOCH)) throw new Error(`${kind}: replay under another challenge accepted`);
  global.gc?.();
  const h0 = process.memoryUsage().heapUsed;
  const verify_us = time(n, () => { f(p, challenge, engine.publicKey, T, EPOCH); });
  const heap_kb = Math.max(0, Math.round((process.memoryUsage().heapUsed - h0) / 1024));
  return {
    approach: kind === 'disclosed' ? 'a) disclosed signed score' : 'b) signed predicate credential',
    verifier_learns: kind === 'disclosed' ? ['agent_id', 'agent key (links every presentation)', 'exact score', 'epoch']
      : ['agent_id', 'agent key (links every presentation)', 'score >= T', 'epoch'],
    issue_us, present_us, verify_us,
    bytes: credential.length + engineSig.length + p.holderSig.length,
    heap_kb,
  };
}

function integrationLines(): Record<string, number> {
  const src = require('node:fs').readFileSync(__filename, 'utf8') as string;
  const count = (tag: string) => {
    const m = src.split(`// BEGIN ${tag}`)[1]?.split(`// END ${tag}`)[0] ?? '';
    return m.split('\n').filter((l) => l.trim() && !l.trim().startsWith('//')).length;
  };
  return { 'a) disclosed signed score': count('verify-disclosed'), 'b) signed predicate credential': count('verify-predicate') };
}

if (require.main === module) {
  const n = Number(process.argv[2] ?? 2000);
  const rows = [run('disclosed', n), run('predicate', n)];
  const lines = integrationLines();
  const ruler = { node: process.version, platform: `${process.platform} ${process.arch}`, iterations: n, crypto: 'Ed25519 (node:crypto)', at: new Date().toISOString() };
  process.stdout.write(JSON.stringify({ ruler, rows: rows.map((r) => ({ ...r, verifier_integration_lines: lines[r.approach] })) }, null, 2) + '\n');
}
