/**
 * The 18 cases of spec §7, as executor-side scripts. Each one builds its own attack out of a
 * valid, signed NPA by changing exactly one thing, presents it to the executor (world.present), and
 * returns what it did. What SHOULD have happened is not decided here: that is oracle.ts's `predict`,
 * written before the script runs. A script never grades itself.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Hex, Npa } from './core';
import { policyBodyOf, policyIdOf } from './core';
import type { CaseId, Prediction, Sym } from './oracle';
import { awardRepid, buildNpa, claimSettlement, present, presentationOf, probeEngineSelfRating, restart, type Attempt, type NpaOpts, type RepidResult, type World, type WorldOpts } from './world';

export interface CaseCtx {
  w: World;
  sym: Sym;
  amount_raw: string;
  work: { statement: string; criteria: string[] };
  /** The deterministic acceptance of the seller's deliverable, decided before payment. */
  accepted: boolean;
}

export interface CaseRun {
  feedback: RepidResult[];
  extra: Record<string, unknown>;
}

export interface CaseDef {
  /** A case that only makes sense for one asset. */
  sym?: Sym;
  /** The seller delivers and the judge is asked: only the cases that reach a RepID decision. */
  delivers?: boolean;
  world?: (sym: Sym, amount_raw: string) => Partial<WorldOpts>;
  run: (c: CaseCtx) => Promise<CaseRun>;
}

const fakeHash = `0x${'ab'.repeat(32)}` as Hex;
const MAX_UINT256 = (2n ** 256n - 1n).toString();
const nothing: CaseRun = { feedback: [], extra: {} };
const perTx = (w: World, sym: Sym) => BigInt(w.policy.per_tx_max_raw[sym]!);

/** Aggregate budgets large enough that only the one-use rule, not a cap, can stop a repeat. */
const ample = (sym: Sym): Partial<WorldOpts> => (sym === 'USDC' ? { aggregateUsdc: '50000000' } : { aggregateEth: '40000000000000000' });

async function pay(c: CaseCtx, label: string, over: Partial<NpaOpts> = {}) {
  const s = await buildNpa(c.w, { sym: c.sym, amount_raw: c.amount_raw, work: c.work, ...over });
  return { s, att: await present(c.w, presentationOf(s), label) };
}

export const CASES: Record<CaseId, CaseDef> = {
  happy_usdc: {
    sym: 'USDC',
    delivers: true,
    async run(c) {
      const { att } = await pay(c, 'pay');
      const rep = att.status === 'SETTLED' ? await awardRepid(c.w, { raterAgentId: c.w.agents.buyer.id, providerAgentId: c.w.agents.seller.id, citedTx: att.tx_hash!, accepted: c.accepted }) : null;
      return { feedback: rep ? [rep] : [], extra: {} };
    },
  },

  happy_eth: {
    sym: 'ETH',
    delivers: true,
    async run(c) {
      const { att } = await pay(c, 'pay');
      const rep = att.status === 'SETTLED' ? await awardRepid(c.w, { raterAgentId: c.w.agents.buyer.id, providerAgentId: c.w.agents.seller.id, citedTx: att.tx_hash!, accepted: c.accepted }) : null;
      return { feedback: rep ? [rep] : [], extra: {} };
    },
  },

  over_per_tx_cap: {
    async run(c) {
      await pay({ ...c, amount_raw: (perTx(c.w, c.sym) + 1n).toString() }, 'pay cap+1');
      return nothing;
    },
  },

  over_aggregate_cap: {
    // The aggregate is 1.5 payments: the first fits, a second identical-size payment (a new NPA) does not.
    world: (sym, amount) => {
      const cap = (BigInt(amount) + BigInt(amount) / 2n).toString();
      return sym === 'USDC' ? { aggregateUsdc: cap } : { aggregateEth: cap };
    },
    async run(c) {
      await pay(c, 'first, within the aggregate');
      await pay(c, 'second, over the aggregate');
      return nothing;
    },
  },

  expired_quote: {
    async run(c) {
      await pay(c, 'pay on an expired quote', { quote_expires_in_s: -1 });
      return nothing;
    },
  },

  wrong_chain: {
    async run(c) {
      await pay(c, 'pay with an NPA for chain 84532', { chain_id: 84532 });
      return nothing;
    },
  },

  token_substitution: {
    sym: 'USDC',
    async run(c) {
      const s = await buildNpa(c.w, { sym: 'USDC', amount_raw: c.amount_raw, work: c.work });
      await present(c.w, presentationOf(s, { asset: c.w.addr.decoy }), 'NPA says USDC, request pays the decoy token');
      return nothing;
    },
  },

  recipient_substitution: {
    async run(c) {
      const s = await buildNpa(c.w, { sym: c.sym, amount_raw: c.amount_raw, work: c.work });
      await present(c.w, presentationOf(s, { recipient: c.w.addr.attacker }), 'NPA names the seller, request pays the attacker');
      return nothing;
    },
  },

  replay_same_authorization: {
    world: (sym) => ample(sym),
    async run(c) {
      const s = await buildNpa(c.w, { sym: c.sym, amount_raw: c.amount_raw, work: c.work });
      const p = presentationOf(s);
      await present(c.w, p, 'first presentation');
      await present(c.w, p, 'the same authorization, presented again after it took effect');
      return nothing;
    },
  },

  replay_after_restart: {
    world: (sym) => ample(sym),
    async run(c) {
      const s = await buildNpa(c.w, { sym: c.sym, amount_raw: c.amount_raw, work: c.work });
      const p = presentationOf(s);
      await present(c.w, p, 'first presentation');
      restart(c.w); // memory dropped, rebuilt from the kernel's JSONL ledger
      await present(c.w, p, 'the same authorization, presented after the engine restarted');
      return { feedback: [], extra: { restart: 'in-memory state dropped; kernel ledger reloaded from its JSONL file' } };
    },
  },

  concurrent_x10: {
    world: (sym) => ample(sym),
    async run(c) {
      const s = await buildNpa(c.w, { sym: c.sym, amount_raw: c.amount_raw, work: c.work });
      const p = presentationOf(s);
      await Promise.all(Array.from({ length: 10 }, (_, i) => present(c.w, p, `concurrent presentation ${i + 1} of 10`)));
      return nothing;
    },
  },

  policy_file_tampered: {
    async run(c) {
      const w = c.w;
      const over = (perTx(w, c.sym) + 1n).toString(); // above the real cap, below the tampered one
      const s = await buildNpa(w, { sym: c.sym, amount_raw: over, work: c.work });
      const original = readFileSync(w.policyPath, 'utf8');
      const raised = JSON.parse(original);
      raised.per_tx_max_raw[c.sym] = (perTx(w, c.sym) * 10n).toString();

      writeFileSync(w.policyPath, JSON.stringify(raised)); // (a) edited, id left as it was
      await present(w, presentationOf(s), 'policy edited, id unchanged');

      raised.policy_id = policyIdOf(policyBodyOf(raised)); // (b) edited and re-stamped consistently
      writeFileSync(w.policyPath, JSON.stringify(raised));
      await present(w, presentationOf(s), 'policy edited and re-stamped with its own new id');

      writeFileSync(w.policyPath, original);
      return nothing;
    },
  },

  npa_one_signature: {
    async run(c) {
      await pay(c, 'seller never signed', { signSeller: false });
      await pay(c, 'seller signature forged by another key', { signSeller: 'forged' });
      return nothing;
    },
  },

  forged_settlement: {
    sym: 'USDC',
    async run(c) {
      const s = await buildNpa(c.w, { sym: 'USDC', amount_raw: c.amount_raw, work: c.work });
      const claims: Attempt[] = [
        await claimSettlement(c.w, s.npa, fakeHash, 'a tx hash that does not exist'),
        await claimSettlement(c.w, s.npa, c.w.fundingTx, 'a real tx hash that is not this payment'),
      ];
      const feedback: RepidResult[] = [];
      for (const a of claims) feedback.push(await awardRepid(c.w, { raterAgentId: c.w.agents.buyer.id, providerAgentId: c.w.agents.seller.id, citedTx: a.tx_hash!, accepted: true }));
      return { feedback, extra: {} };
    },
  },

  unlimited_approve_request: {
    sym: 'USDC',
    async run(c) {
      const s = await buildNpa(c.w, { sym: 'USDC', amount_raw: c.amount_raw, work: c.work });
      await present(c.w, presentationOf(s, { recipient: c.w.addr.attacker, amount_raw: MAX_UINT256 }, 'approve'), 'approve(attacker, 2^256-1)');
      return nothing;
    },
  },

  buyer_equals_seller: {
    async run(c) {
      await pay(c, 'buyer pays itself', { seller: c.w.addr.buyer, signSeller: 'as-buyer' });
      return nothing;
    },
  },

  self_rating_zero_repid: {
    sym: 'USDC',
    delivers: true,
    async run(c) {
      const w = c.w;
      const { att } = await pay(c, 'legitimate payment');
      const cite = att.tx_hash ?? fakeHash;
      const buyer = w.agents.buyer.id;
      const seller = w.agents.seller.id;
      const feedback = [
        await awardRepid(w, { raterAgentId: buyer, providerAgentId: seller, citedTx: cite, accepted: c.accepted }), //            1 the buyer's real feedback
        await awardRepid(w, { raterAgentId: seller, providerAgentId: seller, citedTx: cite, accepted: true }), //                  2 the provider rates itself
        await awardRepid(w, { raterAgentId: buyer, providerAgentId: seller, citedTx: `0x${'cd'.repeat(32)}` as Hex, accepted: true }), // 3 feedback citing a payment that does not exist
        await awardRepid(w, { raterAgentId: buyer, providerAgentId: seller, citedTx: cite, accepted: true }), //                   4 the same feedback again
      ];
      return { feedback, extra: { engine_probe: { what: 'applyServiceSatisfiedDeltas on a self-contract (provider == buyer, non-simulated settlement) with nothing in front of it', ...(await probeEngineSelfRating(w)) } } };
    },
  },

  kill_switch_mid_run: {
    async run(c) {
      const w = c.w;
      await pay(c, 'before the kill switch');
      writeFileSync(w.killPath, 'stop');
      try {
        await pay(c, 'after the kill-switch file appeared');
      } finally {
        rmSync(w.killPath, { force: true });
      }
      return nothing;
    },
  },
};


// ── cases beyond the frozen 18 ───────────────────────────────────────────────────────────────────
// The adversarial lane owns oracle.ts and the 18 case ids. These are executor-side cases it did not list; they are graded
// by the same frozen `grade` with their own prediction (written here, before the case runs).

export const EXTRA_CASE_IDS = ['respelled_replay'] as const;
export type ExtraCaseId = (typeof EXTRA_CASE_IDS)[number];
export interface ExtraCaseDef extends CaseDef {
  predict: (t: { sym: Sym; amount_raw: string }) => Prediction;
}

/** Same bytes, other spelling: EIP-712 encodes an address and a bytes32 as bytes, so none of this changes what was signed. */
const upperBody = (h: string): Hex => `0x${h.slice(2).toUpperCase()}` as Hex;
const respellings = (n: Npa): Npa[] => [
  { ...n, seller: n.seller.toLowerCase() as Hex },
  { ...n, nonce: upperBody(n.nonce) },
  { ...n, service_hash: upperBody(n.service_hash) },
  { ...n, buyer: n.buyer.toLowerCase() as Hex, seller: n.seller.toLowerCase() as Hex, asset: upperBody(n.asset), nonce: upperBody(n.nonce), service_hash: upperBody(n.service_hash) },
];

export const EXTRA_CASES: Record<ExtraCaseId, ExtraCaseDef> = {
  // One signed agreement is ONE authorization however its hex fields are spelled. The same two signatures, the NPA re-cased,
  // must not get a fresh one-use key (XC1-NPA-01, B3): the identity is the EIP-712 digest, not the JSON bytes.
  respelled_replay: {
    world: (sym) => ample(sym),
    predict: (t) => ({
      case: 'respelled_replay' as never,
      ordered: true,
      attempts: ['SETTLED', 'REFUSED', 'REFUSED', 'REFUSED', 'REFUSED'],
      expected_settled: [{ sym: t.sym, amount_raw: t.amount_raw }],
      provider_repid: 'zero',
    }),
    async run(c) {
      const s = await buildNpa(c.w, { sym: c.sym, amount_raw: c.amount_raw, work: c.work });
      await present(c.w, presentationOf(s), 'the agreement as signed');
      for (const [i, n] of respellings(s.npa).entries()) await present(c.w, presentationOf({ ...s, npa: n }), `the same signatures, hex fields re-spelled (${i + 1} of 4)`);
      return nothing;
    },
  },
};
