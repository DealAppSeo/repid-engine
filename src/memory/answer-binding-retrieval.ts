/**
 * answer-binding-retrieval.ts — closes backlog item 4 (answer-binding, patent #1 keystone)
 * over PERSISTED memory, not just an in-process tree.
 *
 * `emitGroundedAnswer` (proof-carrying-memory.ts) already gates a bound answer against a
 * live `ProofCarryingMemory` instance's tree, but that instance never survives past the
 * process that built it. Item 3 (`retrieveVerifiedMemory`, memory-retrieval.ts) closed the
 * gap for READING an agent's stored memory back as a `VerifiedRetrieval` — this module is
 * the missing bridge that lets an EMIT decision use that same persisted retrieval, so an
 * answer can be bound against what a real HTTP caller actually has, not just an in-memory
 * fixture built and torn down in one request.
 *
 * Same abstain contract as `emitGroundedAnswer`: throws rather than returns a binding when a
 * cited value isn't (or is no longer) a verified member of the retrieval's root — this is the
 * enforcement half of "gate answer emit on successful verify", item 4's acceptance test.
 */
import { bindAnswer, type Citation, type ProofCarryingAnswer } from './proof-carrying-memory';
import type { VerifiedRetrieval } from './memory-retrieval';
import type { LeafHash } from './leanimt-plus';
import type { Hash2 } from './proof-carrying-index';
import { poseidon2LeafHash, poseidon2PairHash } from '../zkp/poseidon2-leaf';

const dfltLeaf: LeafHash = poseidon2LeafHash;
const dfltPair: Hash2 = (a, b) => poseidon2PairHash(a, b);

/**
 * Binds `answer` to the citations for `citedValues`, drawn ONLY from `retrieval.entries` (the
 * output of `retrieveVerifiedMemory` — already root-checked and content-checked). Throws
 * `abstain: ...` if `citedValues` is empty or any cited value has no matching verified entry
 * (never added, revoked, or dropped by `retrieveVerifiedMemory`'s own integrity checks) —
 * mirroring `emitGroundedAnswer`'s "no proof, no answer" contract for the persisted case.
 */
export function bindAnswerFromRetrieval(
  answer: string,
  citedValues: string[],
  retrieval: VerifiedRetrieval,
  leafHash: LeafHash = dfltLeaf,
  pair: Hash2 = dfltPair,
): ProofCarryingAnswer {
  if (citedValues.length === 0) {
    throw new Error('abstain: an answer must cite at least one committed memory entry');
  }
  const byValue = new Map(retrieval.entries.map((e) => [e.value, e]));
  const citations: Citation[] = [];
  for (const v of citedValues) {
    const found = byValue.get(v);
    if (!found) {
      throw new Error(`abstain: cited value ${v.slice(0, 12)}… is not a currently verified member of this retrieval`);
    }
    citations.push({ content: found.entry.content, value: v, witness: found.inclusionProof });
  }
  return bindAnswer(answer, citations, retrieval.root, leafHash, pair);
}
