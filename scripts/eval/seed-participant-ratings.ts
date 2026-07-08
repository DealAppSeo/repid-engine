/**
 * seed-participant-ratings.ts — turn the REAL canary fact-check verdicts into
 * participant-rating EDGES, proving L1 (earned-gate) + L2 (ground-truth anchor)
 * on genuine receipts.
 *
 * DATA SOURCE (real, already-verified): the canary F1 run
 *   reports/2026-07-07/canary-f1-raw-2026-07-08T02-17-06-804Z.json
 * — a real cross-LLM quorum whose per-provider, per-claim verdicts were scored
 * against a known-answer oracle. Each provider's committed TRUE/FALSE votes vs the
 * corpus labels ARE L1+L2 data:
 *   L1 (earned): the edge exists ONLY because the provider actually voted on real
 *       claims in a receipted run — no engagement, no rating.
 *   L2 (ground-truth): each vote is scored against the corpus's known label, not
 *       against another model's opinion. Verification strength = 'quorum-verified'
 *       (a family-disjoint panel graded vs a known-answer oracle).
 *
 * The RATER is the canary harness itself (an execution/quorum verifier — an agent
 * node); the RATEE is each LLM/SLM provider. The engagement receipt ref is the
 * canary run id (a real artifact hash), so every edge is auditable back to the run.
 *
 * SHADOW-FIRST: this seeder runs the ledger writer, which DEFAULTS to shadow — it
 * LOGS the would-be edges and mutates no live RepID. Set PARTICIPANT_RATING_MODE=live
 * (Sean-gated, after the migration is applied) to actually persist.
 *
 * Run (from repo root):
 *   npx ts-node scripts/eval/seed-participant-ratings.ts
 * Optional env:
 *   CANARY_RAW=reports/2026-07-07/canary-f1-raw-....json   pin a specific run
 *   PARTICIPANT_RATING_MODE=live                            persist (default: shadow)
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  RatingEdge,
  Participant,
  VerificationStrength,
} from '../../src/engine/participant-rating';
import { recordRatingEdges } from '../../src/engine/participant-rating-ledger';

interface RawVerdict {
  provider: string;
  verdict: string; // 'TRUE' | 'FALSE' | 'UNCERTAIN' | 'ERROR'
  confidence: number;
  error?: string;
  latency_ms: number;
}
interface RawResult {
  idx: number;
  claim: string;
  label: 'TRUE' | 'FALSE';
  domain: string;
  difficulty: string;
  verdicts: RawVerdict[];
}
interface RawRun {
  generated_at: string;
  quorum: Array<{ name: string; model: string; family: string }>;
  results: RawResult[];
}

const DEFAULT_RAW = 'reports/2026-07-07/canary-f1-raw-2026-07-08T02-17-06-804Z.json';

function sha256File(p: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/**
 * Build one rating edge PER PROVIDER from a canary run. The provider's committed
 * (firm TRUE/FALSE) votes are scored against the corpus labels → accuracy +
 * calibration axes (L5 multi-axis). Providers that only errored/abstained produce
 * NO edge (L1: no verified engagement → no rating — honest, never fabricated).
 */
export function edgesFromCanaryRun(run: RawRun, receiptRef: string): {
  edges: RatingEdge[];
  unrated: Array<{ provider: string; reason: string }>;
} {
  // The canary harness itself is the RATER: an execution/quorum verifier node.
  const rater: Participant = {
    id: 'canary-hal-quorum',
    kind: 'agent',
    family: 'harness',
    // The harness is a trusted, execution-anchored verifier — give it a high
    // rater RepID snapshot (L3). This is the harness's standing, not a model's.
    repId: 5000,
  };

  const familyByProvider = new Map(run.quorum.map((q) => [q.name, q.family]));
  const modelByProvider = new Map(run.quorum.map((q) => [q.name, q.model]));

  // Accumulate per-provider committed votes + correctness + latency.
  interface Acc {
    committed: number;
    correct: number;
    errors: number;
    latencies: number[];
    confWhenWrong: number[];
  }
  const acc = new Map<string, Acc>();
  const ensure = (p: string): Acc => {
    let a = acc.get(p);
    if (!a) { a = { committed: 0, correct: 0, errors: 0, latencies: [], confWhenWrong: [] }; acc.set(p, a); }
    return a;
  };

  for (const r of run.results) {
    for (const v of r.verdicts) {
      const a = ensure(v.provider);
      const firm = v.verdict === 'TRUE' || v.verdict === 'FALSE';
      if (v.verdict === 'ERROR') { a.errors++; continue; }
      if (!firm) continue; // UNCERTAIN / abstain — not a committed vote
      a.committed++;
      a.latencies.push(v.latency_ms);
      const correct = v.verdict === r.label;
      if (correct) a.correct++;
      else a.confWhenWrong.push(v.confidence);
    }
  }

  const edges: RatingEdge[] = [];
  const unrated: Array<{ provider: string; reason: string }> = [];

  for (const q of run.quorum) {
    const a = acc.get(q.name);
    if (!a || a.committed === 0) {
      // L1: no committed verified vote → NO edge (never fabricate a score).
      unrated.push({
        provider: q.name,
        reason: `no verified engagement — ${a?.errors ?? 0} errors, 0 committed votes (LAW 1: no rating fabricated)`,
      });
      continue;
    }
    const accuracy = a.correct / a.committed;
    // calibration axis: a well-calibrated model is LESS confident when wrong. We
    // express calibration as 1 - (mean confidence when wrong / 100), so lower
    // confidence-when-wrong ⇒ higher calibration. No wrong answers ⇒ 1.0.
    const meanConfWrong = a.confWhenWrong.length
      ? a.confWhenWrong.reduce((s, x) => s + x, 0) / a.confWhenWrong.length
      : 0;
    const calibration = a.confWhenWrong.length ? 1 - meanConfWrong / 100 : 1.0;
    // coverage axis: committed votes / total claims seen.
    const coverage = a.committed / run.results.length;
    const medLatency = a.latencies.length
      ? a.latencies.slice().sort((x, y) => x - y)[Math.floor(a.latencies.length / 2)]!
      : undefined;

    const ratee: Participant = {
      id: `${q.name}:${q.model}`,
      kind: 'llm',
      family: familyByProvider.get(q.name) ?? q.family,
    };

    edges.push({
      rater,
      ratee,
      axes: {
        accuracy,
        calibration,
        coverage,
        ...(medLatency !== undefined ? { latency: medLatency } : {}),
      },
      // L2: a family-disjoint panel graded these against a known-answer oracle.
      verificationStrength: 'quorum-verified' as VerificationStrength,
      // L1: the receipt — the real canary run this edge is earned from.
      engagementReceiptRef: receiptRef,
      timestamp: run.generated_at,
      note: `earned from ${a.committed} committed votes vs known-answer oracle (${modelByProvider.get(q.name)})`,
    });
  }

  return { edges, unrated };
}

async function main() {
  const rawPath = process.env.CANARY_RAW || DEFAULT_RAW;
  const abs = path.resolve(process.cwd(), rawPath);
  if (!fs.existsSync(abs)) {
    console.error(`[seed] canary raw not found: ${abs}`);
    process.exit(1);
  }
  const run: RawRun = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const receiptRef = `canary-run:${sha256File(abs)}`;

  const { edges, unrated } = edgesFromCanaryRun(run, receiptRef);

  console.log(`\n=== PARTICIPANT-RATING SEED (from canary verdicts) ===`);
  console.log(`receipt (L1): ${receiptRef}`);
  console.log(`run generated_at: ${run.generated_at}`);
  console.log(`rated providers (earned): ${edges.length}`);
  for (const u of unrated) console.log(`  UNRATED — ${u.provider}: ${u.reason}`);

  // SHADOW-FIRST: recordRatingEdges defaults to shadow (logs, no DB, no RepID change).
  const results = await recordRatingEdges(edges, {
    note: 'seed from canary F1 verified verdicts (L1+L2 real receipts)',
    metadata: { source: 'canary-f1', receiptRef },
  });

  const accepted = results.filter((r) => r.accepted).length;
  const persisted = results.filter((r) => r.persisted).length;
  console.log(`\naccepted edges: ${accepted}/${results.length} · persisted: ${persisted} (mode=${results[0]?.mode ?? 'shadow'})`);
  console.log(`(shadow mode logs the would-be edges and mutates NO live RepID.)\n`);
}

// Only run when invoked directly (keeps edgesFromCanaryRun importable by tests).
if (require.main === module) {
  main().catch((e) => {
    console.error('[seed] failed:', e);
    process.exit(1);
  });
}
