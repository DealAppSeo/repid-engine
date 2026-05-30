/**
 * verify:claims <report.md> — sprint-end self-check.
 *
 * Parses a report's QUANTITATIVE / STRUCTURAL claims (authority formula, concurrency
 * mechanism, RLS-disabled count, HAL F1/AUC/separation) and RE-DERIVES each against the
 * live code + DB. Any claim that doesn't reproduce is flagged CONTRADICTED; recognized-and-
 * reproduced claims are REPRODUCES; numeric claims we can't currently derive are UNVERIFIED
 * (never silently "passed"). Exit non-zero iff any CONTRADICTED — so an agent runs this on its
 * own report before handoff and the report can't ship a number the code/DB disagrees with.
 *
 *   npm run verify:claims -- E:/dev/reports/2026-05-30/GA_FORMULA_FIX.md
 *
 * Scope: this catches claims of the KINDS it has extractors for. It is not a universal NLP
 * checker — unrecognized prose is left alone. Add extractors as new claim shapes recur.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { authorityCheck } from './checks/authority';
import { rlsCheck } from './checks/rls';
import { halCheck } from './checks/hal';

type Verdict = 'REPRODUCES' | 'CONTRADICTED' | 'UNVERIFIED';
interface Claim { type: string; quote: string; expected: string; derived: string; verdict: Verdict }

const clip = (s: string, n = 90) => s.replace(/\s+/g, ' ').trim().slice(0, n);

/** ── Extractor: authority formula ─────────────────────────────────────────────
 * Catches a report asserting a particular authority formula and checks the LIVE code
 * actually computes it. Two failure modes: (a) report claims sqrt-synthesis but code
 * doesn't (e.g. fix unmerged); (b) report claims linear/R·W·C but code is sqrt. */
async function extractAuthorityFormula(text: string): Promise<Claim[]> {
  // Does the report ASSERT sqrt-synthesis as the (implemented/correct) formula? Mentions of
  // "linear scaling alters the curve" are a REJECTION of linear, not a claim of it — so the
  // presence of the min(R,100·√S) / anti-whale synthesis dominates.
  const claimsSqrt = /min\s*\(\s*R\s*,?\s*100\s*[*·.\\ ]*\s*\\?sqrt|100\s*[*·]\s*\\?sqrt\s*\(?\s*S|anti-?whale|sqrt\s*synthesis|\\sqrt\{?S/i.test(text);
  // Report asserts linear/R·W·C as the IMPLEMENTED formula (only counts if it's NOT framing it as the wrong approach).
  const linearAsImpl = /(?:formula|authority|implemented|use[ds]?)[^\n]{0,40}(?:R\s*[*×·]\s*W\s*[*×·]\s*C|combinedScore\s*\/\s*500_?000|A\s*=\s*10\s*[*·]\s*S)/i.test(text);
  if (!claimsSqrt && !linearAsImpl) return [];

  // prefer the asserted-formula line (min(R,100·√S)) for the quote
  const quote = (text.match(/[^\n]*(?:A\s*=\s*\\?min|min\s*\(\s*R|100\s*[*·\\ ]{0,4}\\?sqrt)[^\n]*/i)
    || text.match(/[^\n]*(?:R\s*[*×·]\s*W\s*[*×·]\s*C|combinedScore\s*\/\s*500_?000)[^\n]*/i)
    || ['authority-formula claim'])[0];
  const res = await authorityCheck();        // re-derive against current code
  const codeIsSqrt = res.status === 'PASS';  // vectors reproduce min(R,100·√S)
  const got = res.summary;

  // sqrt assertion wins when both appear (a fix report rejects linear AND asserts sqrt).
  const reportSaysSqrt = claimsSqrt;
  const expected = reportSaysSqrt ? 'code computes min(R,100·√S)' : 'code computes linear/R·W·C';
  let verdict: Verdict;
  if (reportSaysSqrt) verdict = codeIsSqrt ? 'REPRODUCES' : 'CONTRADICTED';
  else verdict = codeIsSqrt ? 'CONTRADICTED' : 'REPRODUCES';
  const derived = codeIsSqrt ? 'min(R,100·√S) confirmed by vectors' : `NOT min(R,100·√S) — ${got}`;
  return [{ type: 'authority-formula', quote: clip(quote, 110), expected, derived, verdict }];
}

/** ── Extractor: concurrency mechanism ─────────────────────────────────────────
 * Catches a report claiming an atomic claim / MAX_CONCURRENCY / race-safe worker and
 * checks the mechanism actually exists in the codebase (phantom-claim detector). */
function scanSrc(re: RegExp): string | null {
  const root = join(process.cwd(), 'src');
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[]; try { entries = readdirSync(dir); } catch { continue; }
    for (const e of entries) {
      const p = join(dir, e);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { stack.push(p); continue; }
      if (!/\.ts$/.test(e)) continue;
      let body: string; try { body = readFileSync(p, 'utf8'); } catch { continue; }
      if (re.test(body)) return p.replace(process.cwd(), '').replace(/\\/g, '/');
    }
  }
  return null;
}
async function extractConcurrency(text: string): Promise<Claim[]> {
  const m = text.match(/[^\n]*(MAX_CONCURRENCY|atomic[^\n]{0,12}claim|claimed_by|race-?safe|conditional UPDATE|in-flight)[^\n]*/i);
  if (!m) return [];
  const line = m[0];
  // Re-derive against the SPECIFICALLY-NAMED mechanism(s) — a stray unrelated match (e.g. a
  // pre-existing FOR UPDATE SKIP LOCKED in another module) must NOT mask a phantom claim.
  const named: Array<{ tok: string; re: RegExp }> = [];
  if (/MAX_CONCURRENCY/i.test(line)) named.push({ tok: 'MAX_CONCURRENCY const', re: /\bMAX_CONCURRENCY\b/ });
  if (/claimed_by/i.test(line)) named.push({ tok: 'atomic claimed_by write (SET claimed_by=)', re: /SET\s+claimed_by|claimed_by\s*=\s*[^=]/i });
  if (!named.length) named.push({ tok: 'atomic claim (SET claimed_by / SKIP LOCKED)', re: /SET\s+claimed_by|FOR\s+UPDATE\s+SKIP\s+LOCKED/i });

  const results = named.map(n => ({ tok: n.tok, where: scanSrc(n.re) }));
  const missing = results.filter(r => !r.where);
  const verdict: Verdict = missing.length ? 'CONTRADICTED' : 'REPRODUCES';
  const foundStr = results.filter(r => r.where).map(r => `${r.tok}@${r.where}`).join(', ');
  const derived = missing.length
    ? `PHANTOM — missing in src/: ${missing.map(r => r.tok).join('; ')}${foundStr ? ` (unrelated found: ${foundStr})` : ''}`
    : `found: ${foundStr}`;
  return [{ type: 'concurrency', quote: clip(line, 110), expected: `named mechanism(s) in code: ${named.map(n => n.tok).join('; ')}`, derived, verdict }];
}

/** ── Extractor: RLS-disabled count ────────────────────────────────────────────*/
async function extractRlsCount(text: string): Promise<Claim[]> {
  const m = text.match(/(\d{1,4})\s*(?:public\s*)?tables?[^\n]{0,30}(?:RLS|row[- ]?level)[^\n]{0,20}(?:disabled|off)|(?:RLS|row[- ]?level)[^\n]{0,20}disabled[^\n]{0,20}(\d{1,4})/i);
  if (!m) return [];
  const claimed = Number(m[1] ?? m[2]);
  const res = await rlsCheck();
  if (res.status === 'SKIP') return [{ type: 'rls-count', quote: clip(m[0]), expected: `${claimed} disabled`, derived: 'DB unavailable', verdict: 'UNVERIFIED' }];
  const actual = Number((res.detail as any)?.public_tables_rls_disabled_total ?? -1);
  const verdict: Verdict = actual === claimed ? 'REPRODUCES' : 'CONTRADICTED';
  return [{ type: 'rls-count', quote: clip(m[0]), expected: `${claimed} disabled`, derived: `${actual} disabled (live)`, verdict }];
}

/** ── Extractor: HAL discrimination metrics (F1 / AUC / separation) ─────────────*/
async function extractHalMetrics(text: string): Promise<Claim[]> {
  const out: Claim[] = [];
  const f1m = text.match(/F1[^0-9]{0,8}(0?\.\d{2,3})/i);
  const sepm = text.match(/separation[^0-9-]{0,12}([+-]?0?\.\d{2,3})/i);
  if (!f1m && !sepm) return out;
  const res = await halCheck();
  const d: any = res.detail ?? {};
  if (res.status === 'SKIP') {
    if (f1m) out.push({ type: 'hal-f1', quote: clip(f1m[0]), expected: `F1≈${f1m[1]}`, derived: `not run (${res.skipReason})`, verdict: 'UNVERIFIED' });
    return out;
  }
  if (f1m) {
    const claimed = Number(f1m[1]); const got = Number(d.f1 ?? -1);
    // tolerance wide: sampled live run vs a full-corpus report figure
    out.push({ type: 'hal-f1', quote: clip(f1m[0]), expected: `F1≈${claimed}`, derived: `F1=${got} (n=${d.sampled})`, verdict: Math.abs(got - claimed) <= 0.15 ? 'REPRODUCES' : 'CONTRADICTED' });
  }
  if (sepm) {
    const claimed = Number(sepm[1]); const got = Number(d.separation ?? 0);
    // direction is the load-bearing part (sep>0 = discriminates)
    out.push({ type: 'hal-separation', quote: clip(sepm[0]), expected: `sep≈${claimed}`, derived: `sep=${got}`, verdict: (got > 0) === (claimed > 0) ? 'REPRODUCES' : 'CONTRADICTED' });
  }
  return out;
}

(async () => {
  const file = process.argv.slice(2).find(a => !a.startsWith('-'));
  if (!file) { console.error('usage: verify:claims <report.md>'); process.exit(2); }
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch (e: any) { console.error(`cannot read ${file}: ${e?.message ?? e}`); process.exit(2); }

  const extractors = [extractAuthorityFormula, extractConcurrency, extractRlsCount, extractHalMetrics];
  const claims: Claim[] = [];
  for (const ex of extractors) {
    try { claims.push(...await ex(text)); }
    catch (e: any) { console.error(`  (extractor ${ex.name} errored: ${e?.message ?? e})`); }
  }

  const icon = (v: Verdict) => (v === 'REPRODUCES' ? '✅' : v === 'CONTRADICTED' ? '❌' : '⚠️ ');
  console.log(`\n  verify:claims  ${file}`);
  console.log('  ────────────────────────────────────────────────────────');
  if (!claims.length) console.log('  (no recognized quantitative/structural claims — nothing to re-derive)');
  for (const c of claims) {
    console.log(`  ${icon(c.verdict)} [${c.type}] ${c.verdict}`);
    console.log(`      claim:   "${c.quote}"`);
    console.log(`      expect:  ${c.expected}`);
    console.log(`      derived: ${c.derived}`);
  }
  const contradicted = claims.filter(c => c.verdict === 'CONTRADICTED');
  const unverified = claims.filter(c => c.verdict === 'UNVERIFIED');
  console.log('  ────────────────────────────────────────────────────────');
  console.log(`  ${claims.filter(c => c.verdict === 'REPRODUCES').length} reproduce · ${contradicted.length} CONTRADICTED · ${unverified.length} unverified`);
  console.log(`  RESULT: ${contradicted.length ? '❌ report asserts claim(s) the code/DB contradict' : '✅ no contradicted claims'}\n`);
  process.exit(contradicted.length ? 1 : 0);
})().catch(e => { console.error('verify:claims crashed:', e); process.exit(2); });
