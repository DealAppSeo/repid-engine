/**
 * Authority composition — the properties the overnight plan (item 3, "thin default-deny policy
 * kernel, signed owner policy, attenuation") asks for, pinned against the kernel that ALREADY
 * EXISTS (`decide.ts`). Nothing here builds a new kernel.
 *
 * What these tests pin, at the pure decide() level:
 *   A. The spend ceiling is a MIN: effective = min(per_tx, daily remaining, total remaining), and
 *      an ALLOW never exceeds it. A max(), a sum or a skipped term goes red here.
 *   B. Attenuation is monotone: narrowing an owner policy (fewer actions, fewer payees, lower
 *      limits, earlier expiry) can never turn a DENY into an ALLOW.
 *   C. A missing or unreadable input is never an ALLOW (DENY or NOT_CHECKED only).
 *   D. RepID, tier and stake are NOT authority inputs. The request parser rejects them, and if one
 *      is smuggled onto the decide() input object it changes nothing. RepID can therefore never
 *      raise authority above the owner's grant — it is not wired in at all.
 *
 * What these tests do NOT establish (say so, do not imply it):
 *   - RepID-based ELIGIBILITY (the "domain RepID eligibility" term of min(owner grant, RepID
 *     eligibility, safety floor)) is ABSENT from the kernel: it cannot lower authority either.
 *     That term is unbuilt, not passed.
 *   - Child ⊆ parent capability attenuation across a DELEGATION chain: the kernel has no
 *     delegation surface (gate.ts: "There is no delegation or passthrough hole"); the parser
 *     refuses a `delegation`/`parent` field. B covers attenuation of one owner policy only.
 */
import { decide, parseKernelRequest } from '../decide';
import type { DecideInput, KernelRequest, OwnerPolicy } from '../types';
import { AGENT_ID, NOW_S, PAYEE, postRequest, spendRequest } from './fixtures';

const OWNER = '0x000000000000000000000000000000000000bEEF';
const OTHER_PAYEE = '0x000000000000000000000000000000000000cAFE';

function req(raw: Record<string, unknown>): KernelRequest {
  const p = parseKernelRequest(raw);
  if (!p.ok) throw new Error(`fixture request did not parse: ${JSON.stringify(p.reasons)}`);
  return p.request;
}

function policy(over: Partial<OwnerPolicy> = {}): OwnerPolicy {
  return {
    subject: AGENT_ID,
    owner: OWNER,
    actions: ['spend', 'post', 'tool'],
    payees: [PAYEE, OTHER_PAYEE],
    per_tx_raw: '1000',
    daily_raw: '5000',
    total_raw: '20000',
    expires_at: NOW_S + 3600,
    nonce: '1',
    ...over,
  };
}

const HAL_PASS = {
  state: 'consulted' as const,
  evidence: { verdict: 'PASS' as const, method: 'test', votes: [], settled_by: 'known_answer' as const, grounded: true, same_domain: true },
};

function input(p: OwnerPolicy, request: KernelRequest, over: Partial<DecideInput> = {}): DecideInput {
  return {
    request,
    now_s: NOW_S,
    owner: { status: 'resolved', wallet: OWNER, assurance: 'wallet-proven' },
    policy: { state: 'loaded', policy: p, policy_hash: '0x' + 'ab'.repeat(32), signature: 'VERIFIED', revocation: 'VERIFIED' },
    spent: { state: 'ok', daily_raw: '0', total_raw: '0' },
    hal: request.tool.class === 'post' ? HAL_PASS : { state: 'not_needed' },
    ...over,
  };
}

const big = (s: string): bigint => BigInt(s);
const minOf = (...xs: bigint[]): bigint => xs.reduce((a, b) => (b < a ? b : a));
const left = (cap: bigint, used: bigint): bigint => (cap > used ? cap - used : 0n);

describe('kernel authority composition (overnight item 3)', () => {
  it('controls: the base fixture ALLOWs a spend and a post (else every DENY below is vacuous)', () => {
    expect(decide(input(policy(), req(spendRequest({ amount_raw: 10 })))).verdict).toBe('ALLOW');
    expect(decide(input(policy(), req(postRequest()))).verdict).toBe('ALLOW');
  });

  describe('A. the spend ceiling is min(per_tx, daily remaining, total remaining)', () => {
    const perTxs = ['0', '100', '1000'];
    const dailies = ['0', '500', '2000'];
    const totals = ['0', '300', '5000'];
    const spentDaily = ['0', '400'];
    const spentTotal = ['0', '250'];
    const amounts = ['1', '50', '120', '600'];

    it('effective limit, binding term and verdict agree with an independent min() over a grid', () => {
      let allows = 0;
      let denies = 0;
      for (const pt of perTxs) for (const d of dailies) for (const t of totals)
        for (const sd of spentDaily) for (const st of spentTotal) for (const amt of amounts) {
          const leg = decide(input(
            policy({ per_tx_raw: pt, daily_raw: d, total_raw: t }),
            req(spendRequest({ amount_raw: Number(amt) })),
            { spent: { state: 'ok', daily_raw: sd, total_raw: st } },
          ));
          const terms = { per_tx: big(pt), daily: left(big(d), big(sd)), total: left(big(t), big(st)) };
          const expected = minOf(terms.per_tx, terms.daily, terms.total);
          const where = `per_tx=${pt} daily=${d} total=${t} spent=${sd}/${st} amount=${amt}`;

          expect([where, leg.limits.effective_per_tx_raw]).toEqual([where, expected.toString()]);
          // The term named as binding really is the one at the minimum.
          const bound = terms[leg.limits.binding_term as keyof typeof terms];
          expect([where, bound]).toEqual([where, expected]);

          const shouldAllow = big(amt) <= expected;
          expect([where, leg.verdict]).toEqual([where, shouldAllow ? 'ALLOW' : 'DENY']);
          if (leg.verdict === 'ALLOW') {
            allows++;
            expect(big(amt) <= big(leg.limits.effective_per_tx_raw)).toBe(true);
          } else denies++;
        }
      // Non-vacuity: the grid exercises both outcomes.
      expect(allows).toBeGreaterThan(0);
      expect(denies).toBeGreaterThan(0);
    });
  });

  describe('B. attenuation is monotone: narrowing a policy never turns DENY into ALLOW', () => {
    // Each narrowing only removes authority. Applied as a set, in any combination.
    const narrowings: Record<string, (p: OwnerPolicy) => OwnerPolicy> = {
      drop_spend: (p) => ({ ...p, actions: p.actions.filter((a) => a !== 'spend') }),
      drop_post: (p) => ({ ...p, actions: p.actions.filter((a) => a !== 'post') }),
      drop_tool: (p) => ({ ...p, actions: p.actions.filter((a) => a !== 'tool') }),
      drop_payee: (p) => ({ ...p, payees: (p.payees ?? []).filter((x) => x !== PAYEE) }),
      lower_per_tx: (p) => ({ ...p, per_tx_raw: '5' }),
      lower_daily: (p) => ({ ...p, daily_raw: '5' }),
      lower_total: (p) => ({ ...p, total_raw: '5' }),
      expire: (p) => ({ ...p, expires_at: NOW_S }),
    };
    const names = Object.keys(narrowings);
    const apply = (mask: number): OwnerPolicy =>
      names.reduce((p, n, i) => ((mask >> i) & 1 ? narrowings[n]!(p) : p), policy());

    const requests: Array<[string, KernelRequest]> = [
      ['spend 10', req(spendRequest({ amount_raw: 10 }))],
      ['spend 3', req(spendRequest({ amount_raw: 3 }))],
      ['post', req(postRequest())],
    ];

    // Monotonicity alone passes for a narrowing that does nothing (an ignored expiry is still
    // "monotone"). So also pin that each narrowing that removes what the call needs, alone, denies.
    const mustDeny: Record<string, string[]> = {
      'spend 10': ['drop_spend', 'drop_payee', 'lower_per_tx', 'lower_daily', 'lower_total', 'expire'],
      'spend 3': ['drop_spend', 'drop_payee', 'expire'],
      post: ['drop_post', 'expire'],
    };
    const mustAllow: Record<string, string[]> = {
      'spend 10': ['drop_post', 'drop_tool'],
      'spend 3': ['drop_post', 'drop_tool', 'lower_per_tx', 'lower_daily', 'lower_total'],
      post: ['drop_spend', 'drop_tool', 'drop_payee', 'lower_per_tx', 'lower_daily', 'lower_total'],
    };

    for (const [label, r] of requests) {
      it(`${label}: each narrowing alone takes effect exactly where the call needs that authority`, () => {
        for (const n of mustDeny[label]!) expect([n, decide(input(narrowings[n]!(policy()), r)).verdict]).toEqual([n, 'DENY']);
        for (const n of mustAllow[label]!) expect([n, decide(input(narrowings[n]!(policy()), r)).verdict]).toEqual([n, 'ALLOW']);
        expect(mustDeny[label]!.length + mustAllow[label]!.length).toBe(names.length);
      });

      it(`${label}: if a narrower policy ALLOWs, every broader one does too`, () => {
        const verdicts: string[] = [];
        for (let mask = 0; mask < 1 << names.length; mask++) verdicts[mask] = decide(input(apply(mask), r)).verdict;
        let checkedPairs = 0;
        for (let mask = 0; mask < verdicts.length; mask++) {
          if (verdicts[mask] !== 'ALLOW') continue;
          // every subset of this narrowing set is broader (or equal) and must ALLOW too
          for (let sub = mask; ; sub = (sub - 1) & mask) {
            expect([label, mask, sub, verdicts[sub]]).toEqual([label, mask, sub, 'ALLOW']);
            checkedPairs++;
            if (sub === 0) break;
          }
        }
        // Non-vacuity: the unnarrowed policy allows, and some narrowing denies.
        expect(verdicts[0]).toBe('ALLOW');
        expect(verdicts.some((v) => v !== 'ALLOW')).toBe(true);
        expect(checkedPairs).toBeGreaterThan(0);
      });
    }
  });

  describe('C. a missing or unreadable input is never an ALLOW', () => {
    const spend = req(spendRequest({ amount_raw: 10 }));
    const post = req(postRequest());
    const p = policy();
    const cases: Array<[string, DecideInput, 'DENY' | 'NOT_CHECKED']> = [
      ['owner unknown', input(p, spend, { owner: { status: 'unknown', wallet: null, assurance: null } }), 'NOT_CHECKED'],
      ['owner none', input(p, spend, { owner: { status: 'none', wallet: null, assurance: null } }), 'DENY'],
      ['policy absent', input(p, spend, { policy: { state: 'absent' } }), 'DENY'],
      ['policy store unreadable', input(p, spend, { policy: { state: 'not_checked', detail: 'down' } }), 'NOT_CHECKED'],
      ['signature not checked', input(p, spend, { policy: { state: 'loaded', policy: p, policy_hash: '0x' + 'ab'.repeat(32), signature: 'NOT_CHECKED', revocation: 'VERIFIED' } }), 'NOT_CHECKED'],
      ['signature failed', input(p, spend, { policy: { state: 'loaded', policy: p, policy_hash: '0x' + 'ab'.repeat(32), signature: 'FAILED', revocation: 'VERIFIED' } }), 'DENY'],
      ['revocation not checked', input(p, spend, { policy: { state: 'loaded', policy: p, policy_hash: '0x' + 'ab'.repeat(32), signature: 'VERIFIED', revocation: 'NOT_CHECKED' } }), 'NOT_CHECKED'],
      ['spend totals unreadable', input(p, spend, { spent: { state: 'not_checked', detail: 'down' } }), 'NOT_CHECKED'],
      ['spend totals not supplied', input(p, spend, { spent: { state: 'not_needed' } }), 'NOT_CHECKED'],
      ['HAL not consulted on a post', input(p, post, { hal: { state: 'not_checked', detail: 'down' } }), 'NOT_CHECKED'],
      ['HAL not needed claimed on a post', input(p, post, { hal: { state: 'not_needed' } }), 'NOT_CHECKED'],
    ];
    for (const [name, i, expected] of cases) {
      it(`${name} → ${expected}`, () => {
        const leg = decide(i);
        expect(leg.verdict).toBe(expected);
        expect(leg.blocking).toBe(true);
      });
    }
  });

  describe('D. RepID, tier and stake are not authority inputs', () => {
    it.each(['repid', 'current_repid', 'tier', 'stake', 'stake_raw', 'reputation', 'delegation', 'parent'])(
      'the request parser refuses a "%s" field',
      (k) => {
        const p = parseKernelRequest({ ...spendRequest(), [k]: k === 'tier' ? 'VETERAN' : 10000 });
        expect(p.ok).toBe(false);
      },
    );

    it('a maximal RepID smuggled onto the decide() input changes nothing (DENY stays DENY, ALLOW stays bounded)', () => {
      const smuggle = { repid: 10000, current_repid: 10000, tier: 'VETERAN', stake_raw: '1' + '0'.repeat(30) };
      const zero = input(policy({ per_tx_raw: '0' }), req(spendRequest({ amount_raw: 10 })));
      const zeroOut = decide({ ...zero, ...smuggle } as unknown as DecideInput);
      expect(zeroOut).toEqual(decide(zero));
      expect(zeroOut.verdict).toBe('DENY');

      const ok = input(policy(), req(spendRequest({ amount_raw: 10 })));
      const okOut = decide({ ...ok, ...smuggle } as unknown as DecideInput);
      expect(okOut).toEqual(decide(ok));
      expect(okOut.limits.effective_per_tx_raw).toBe('1000');
    });
  });
});
