/**
 * proof-carrying-e2e.ts — THE convergence run.
 *
 * One runnable artifact that is, at once: the patent-#1 reduction-to-practice
 * ("an end-to-end run exists"), the Wednesday hackathon demo (hallucinating agent
 * vs proof-carrying agent), and a live validation of the whole substrate.
 *
 * The loop: COMMIT a fact -> RETRIEVE it with a cryptographic proof -> BIND the
 * proof into the answer -> REVOKE the fact -> the current-validity check now FAILS
 * -> HAL ABSTAINS -> ANCHOR the memory root on-chain (EAS/Base Sepolia).
 *
 * Side-by-side, a naive agent (plain key-value, no proofs, never forgets) keeps
 * asserting the retracted fact. Same question, one is auditable, one hallucinates.
 *
 *   npx tsx scripts/demo/proof-carrying-e2e.ts
 *
 * Prints a narrated transcript and exits 0 iff the whole loop holds. The EAS anchor
 * uses an injected mock so the demo runs offline; a live run swaps in the real
 * attestProof (funded Base-Sepolia attester) to produce a real on-chain attestation.
 */
import { ProofCarryingMemory, verifyProofCarryingAnswer, emitGroundedAnswer } from '../../src/memory/proof-carrying-memory';
import { computeGroundingSignal } from '../../src/hal/hal-grounding';
import { anchorMemoryRoot } from '../../src/memory/memory-root-anchor';

/** A naive agent: a plain map, no proofs, no notion of "no longer valid". */
class NaiveAgent {
  private mem = new Map<string, string>();
  learn(key: string, fact: string) { this.mem.set(key, fact); }
  answer(key: string) { return this.mem.get(key) ?? '(no answer)'; }
}

const P = (s = '') => console.log(s);
const STAGE = (n: number, t: string) => console.log(`\n─── STAGE ${n}: ${t} ───`);

export async function runProofCarryingE2E(verbose = true): Promise<boolean> {
  const line = verbose ? P : () => {};
  const stage = verbose ? STAGE : () => {};

  const pcm = new ProofCarryingMemory();
  const naive = new NaiveAgent();
  const FACT = 'The Q3 audit found no material weaknesses.';
  const KEY = 'q3-audit-finding';

  stage(1, 'COMMIT a fact into the agent\'s memory');
  const v = pcm.add({ content: FACT, source_id: 'auditor-agent', source_repid: 1800, hal_verdict: 'clean', epoch: 1 });
  naive.learn(KEY, FACT);
  line(`  committed → memory value ${v.slice(0, 20)}…`);
  line(`  committed memory root: ${pcm.root().slice(0, 30)}…`);

  stage(2, 'RETRIEVE with a cryptographic proof + BIND it into the answer');
  const pca = emitGroundedAnswer(FACT, pcm, [v]);
  const ver1 = verifyProofCarryingAnswer(pca);
  line(`  proof-carrying agent → "${pca.answer}"`);
  line(`     ✅ grounded=${ver1.grounded}  citations verified=${ver1.verified_citations}/${ver1.total_citations}  binding_ok=${ver1.binding_ok}`);
  line(`  naive agent          → "${naive.answer(KEY)}"   (no proof, just asserts)`);

  stage(3, 'REVOKE the fact — a later review supersedes it (now known false)');
  pcm.revoke(v);
  line(`  revoked. new memory root: ${pcm.root().slice(0, 30)}…   ← the root moved: the retraction is itself provable`);

  stage(4, 'ASK AGAIN — the money shot');
  let pcAbstained = false;
  let pcMsg = '(answered — BUG)';
  try { emitGroundedAnswer(FACT, pcm, [v]); }
  catch (e: any) { pcAbstained = true; pcMsg = e.message; }
  const staleGrounded = verifyProofCarryingAnswer({ ...pca, memory_root: pcm.root() }).grounded;
  const gsig = computeGroundingSignal({ proof_carrying_answer: { ...pca, memory_root: pcm.root() } }, 'shadow');
  line(`  proof-carrying agent → ABSTAINS: "${pcMsg}"`);
  line(`     the earlier answer, re-checked against the new root: grounded=${staleGrounded}  (HAL would_abstain=${gsig.would_abstain})`);
  line(`  naive agent          → "${naive.answer(KEY)}"   ← STILL asserts the RETRACTED fact (hallucination, no audit trail)`);

  stage(5, 'ANCHOR the memory root on-chain (EAS / Base Sepolia)');
  const anchor = await anchorMemoryRoot(
    { agentId: 'auditor-agent', tier: 'AUTONOMOUS', root: pcm.root(), epoch: 2, repidSnapshot: 1800 },
    async () => ({ uid: '0xDEMO_UID_replace_with_live_attester', txHash: '0xDEMO_TX' }),
  );
  line(`  anchored=${anchor.anchored}  uid=${anchor.uid}`);
  line('     → anyone can later verify a proof was against a root the agent committed at a known time.');

  const ok = ver1.grounded === true
    && pcAbstained === true
    && staleGrounded === false
    && gsig.would_abstain === true
    && anchor.anchored === true;

  line();
  line(ok ? '════════ E2E PROOF-CARRYING LOOP: PASS ════════' : '════════ E2E: FAIL ════════');
  line('The proof-carrying agent proved what it knew, provably retracted it, and abstained.');
  line('The naive agent hallucinated the retracted fact. Same question — one is auditable, one is not.');
  return ok;
}

// Run as a script (not when imported by a test).
if (require.main === module) {
  runProofCarryingE2E(true).then((ok) => process.exit(ok ? 0 : 1)).catch((e) => { console.error(e); process.exit(1); });
}
