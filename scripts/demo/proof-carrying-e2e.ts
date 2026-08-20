/**
 * proof-carrying-e2e.ts — THE convergence run.
 *
 * One runnable artifact that is, at once: the reduction-to-practice
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
 *   npx tsx scripts/demo/proof-carrying-e2e.ts            # offline: stage 5 anchor is a mock
 *   npx tsx scripts/demo/proof-carrying-e2e.ts --live     # real EAS attestation on Base Sepolia
 *
 * Prints a narrated transcript and exits 0 iff the whole loop holds. Stages 1-4 are
 * identical either way — they are pure crypto and never touch the network. Only stage 5
 * (the on-chain anchor) differs: offline it uses an injected mock; `--live` uses the real
 * attester and REFUSES to run without a funded key rather than quietly printing a fake UID.
 */
import { ProofCarryingMemory, verifyProofCarryingAnswer, emitGroundedAnswer } from '../../src/memory/proof-carrying-memory';
import { computeGroundingSignal } from '../../src/hal/hal-grounding';
import { anchorMemoryRoot, type AttestFn } from '../../src/memory/memory-root-anchor';
import { attestProof, hasAttesterKey } from '../../src/services/eas-attestation-service';

/** Offline stand-in for the chain write. Named so it can never be mistaken for a real UID on screen. */
const MOCK_ATTEST: AttestFn = async () => ({ uid: '0xMOCK_UID_offline_demo_not_on_chain', txHash: '0xMOCK_TX' });

/**
 * Pick the stage-5 anchor writer. A `--live` run must produce a REAL attestation or fail loudly:
 * silently degrading to the mock would put a fabricated on-chain claim on a demo screen (and into
 * the permanent record), which is exactly the failure mode this whole artifact exists to argue against.
 */
export function selectAnchorFn(live: boolean, keyPresent: boolean): { fn: AttestFn; label: string } {
  if (!live) return { fn: MOCK_ATTEST, label: 'offline mock — pass --live for a real Base Sepolia attestation' };
  if (!keyPresent) {
    throw new Error(
      '--live needs a funded attester: set HYPERDAG_ATTESTOR_PRIVATE_KEY (or EAS_ATTESTER_PRIVATE_KEY). ' +
      'Refusing to print a mock UID as if it were on-chain.',
    );
  }
  return { fn: attestProof, label: 'LIVE — EAS on Base Sepolia' };
}

/** A naive agent: a plain map, no proofs, no notion of "no longer valid". */
class NaiveAgent {
  private mem = new Map<string, string>();
  learn(key: string, fact: string) { this.mem.set(key, fact); }
  answer(key: string) { return this.mem.get(key) ?? '(no answer)'; }
}

const P = (s = '') => console.log(s);
const STAGE = (n: number, t: string) => console.log(`\n─── STAGE ${n}: ${t} ───`);

export async function runProofCarryingE2E(verbose = true, live = false): Promise<boolean> {
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
  // THE REPLAY. A stale or dishonest agent does not rebuild anything — it re-sends the ORIGINAL
  // answer, untouched, whose root and witness still agree with each other. That answer is still
  // valid evidence about the superseded state, and the pure verifier says so. Currency is the
  // separate check: HAL holds the root it trusts as current and refuses the superseded one.
  const replayAtOwnRoot = verifyProofCarryingAnswer(pca).grounded;
  const gsig = computeGroundingSignal({ proof_carrying_answer: pca, current_memory_root: pcm.root() }, 'shadow');
  line(`  proof-carrying agent → ABSTAINS: "${pcMsg}"`);
  line(`     replay of the earlier answer: still valid at its OWN (now superseded) root → grounded=${replayAtOwnRoot}`);
  line(`     HAL, holding the current root → root_current=${gsig.root_current}  would_abstain=${gsig.would_abstain}  (${gsig.reason})`);
  line(`  naive agent          → "${naive.answer(KEY)}"   ← STILL asserts the RETRACTED fact (hallucination, no audit trail)`);

  stage(5, 'ANCHOR the memory root on-chain (EAS / Base Sepolia)');
  const { fn: attester, label } = selectAnchorFn(live, hasAttesterKey());
  line(`  attester: ${label}`);
  const anchor = await anchorMemoryRoot(
    { agentId: 'auditor-agent', tier: 'AUTONOMOUS', root: pcm.root(), epoch: 2, repidSnapshot: 1800 },
    attester,
  );
  line(`  anchored=${anchor.anchored}  uid=${anchor.uid}${anchor.error ? `  error=${anchor.error}` : ''}`);
  if (live && anchor.uid) {
    line(`     tx:       https://sepolia.basescan.org/tx/${anchor.txHash}`);
    line(`     attestation: https://base-sepolia.easscan.org/attestation/view/${anchor.uid}`);
  }
  line('     → anyone can later verify a proof was against a root the agent committed at a known time.');

  const ok = ver1.grounded === true
    && pcAbstained === true
    && replayAtOwnRoot === true      // the attack is real — the replay is not self-defeating
    && gsig.root_current === false   // ...and it is caught by currency, not by luck
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
  const live = process.argv.includes('--live');
  runProofCarryingE2E(true, live)
    .then((ok) => process.exit(ok ? 0 : 1))
    .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
