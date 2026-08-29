/**
 * proof-carrying-verify.ts — the "verifier endpoint" half of backlog item 3
 * (PROOF_CARRYING_RETRIEVAL_v0 P2, patent #1 reduction-to-practice).
 *
 * `verifyProofCarryingAnswer` (src/memory/proof-carrying-memory.ts) already exists as a
 * pure, stateless, adversarial-input-safe function — this route is a thin HTTP wrapper so a
 * PEER (not just in-process code) can check a proof-carrying answer without importing this
 * repo's memory module. It takes no dependency on any specific agent's memory store: the
 * caller supplies the full `ProofCarryingAnswer` (answer, memory_root, citations, binding)
 * and the response says whether it verifies against that root.
 *
 * This does NOT close backlog item 3 — the retrieval half (wrapping `ProofCarryingMemory
 * .retrieve()` / `.nonMembershipWitness()` behind an authenticated per-agent endpoint) needs a
 * persistence design this beat did not make, and is left open. See
 * reports/2026-07-26/PATENT_ALIGNED_BUILD_BACKLOG.md item 3.
 *
 * JSON transport note: `InclusionWitness.leaf.{value,next}` are `bigint` in-process (JSON has
 * no bigint type), so the wire contract encodes them as decimal strings; this route revives
 * them before verifying. A malformed/non-numeric value is left as-is rather than rejected —
 * `verifyProofCarryingAnswer` is adversarial-input-safe and reports it as an unverified
 * citation instead of throwing, which is the behavior a peer checking untrusted input needs.
 */
import express from 'express';
import { verifyProofCarryingAnswer, type ProofCarryingAnswer, type Citation } from '../memory/proof-carrying-memory';

const router = express.Router();

function reviveCitation(c: any): any {
  if (!c || typeof c !== 'object' || !c.witness || typeof c.witness !== 'object' || !c.witness.leaf) return c;
  try {
    return { ...c, witness: { ...c.witness, leaf: { ...c.witness.leaf, value: BigInt(c.witness.leaf.value), next: BigInt(c.witness.leaf.next) } } };
  } catch {
    return c; // non-numeric leaf fields — leave as-is, verifyMembership's own guard marks it unverified
  }
}

router.post('/verify', (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'body must be a JSON object: { answer, memory_root, citations, binding }' });
  }
  const citations: Citation[] = Array.isArray(body.citations) ? body.citations.map(reviveCitation) : body.citations;
  const result = verifyProofCarryingAnswer({ ...body, citations } as ProofCarryingAnswer);
  res.json(result);
});

export default router;
