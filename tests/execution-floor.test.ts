/**
 * Execution-floor + claim-typing tests.
 *
 * Covers the P0 "execution beats explanation" law:
 *   1. a TRUE math claim executes + passes
 *   2. a FALSE math claim executes + fails and (live) overrides an LLM "pass"
 *   3. a non-executable claim falls through to HAL untouched (shadow + live)
 *   4. on-chain lookup path works (mocked reader — deterministic in CI)
 * plus claim-typing + safe-arithmetic units.
 */
import {
  extractTypedClaims,
  typeClaim,
  segmentClaims,
} from '../src/hal/claim-typing';
import { safeEvalArithmetic } from '../src/hal/safe-arithmetic';
import {
  runExecutionFloor,
  applyExecutionFloor,
  checkClaim,
  __setOnchainReader,
  type OnchainReader,
} from '../src/hal/execution-floor';

// Helper to run an async fn with a specific EXECUTION_FLOOR_ENABLED value.
// MUST await inside the try so the env var is not restored before the async
// floor reads it (the flag is read at report-build time, mid-Promise).
async function withFlag<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.EXECUTION_FLOOR_ENABLED;
  if (value === undefined) delete process.env.EXECUTION_FLOOR_ENABLED;
  else process.env.EXECUTION_FLOOR_ENABLED = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.EXECUTION_FLOOR_ENABLED;
    else process.env.EXECUTION_FLOOR_ENABLED = prev;
  }
}

afterEach(() => {
  __setOnchainReader(undefined); // reset the RPC seam
  delete process.env.EXECUTION_FLOOR_ENABLED;
});

// ---------------------------------------------------------------------------
// safe-arithmetic
// ---------------------------------------------------------------------------
describe('safeEvalArithmetic', () => {
  it('evaluates basic arithmetic', () => {
    expect(safeEvalArithmetic('2 + 2')).toMatchObject({ ok: true, value: 4 });
    expect(safeEvalArithmetic('10 * (3 + 4)')).toMatchObject({ ok: true, value: 70 });
    expect(safeEvalArithmetic('2 ^ 10')).toMatchObject({ ok: true, value: 1024 });
    expect(safeEvalArithmetic('-5 + 3')).toMatchObject({ ok: true, value: -2 });
  });

  it('handles percent and "of"', () => {
    expect(safeEvalArithmetic('50%')).toMatchObject({ ok: true, value: 0.5 });
    expect(safeEvalArithmetic('10% of 250')).toMatchObject({ ok: true, value: 25 });
  });

  it('handles thousands separators', () => {
    expect(safeEvalArithmetic('1,000 + 500')).toMatchObject({ ok: true, value: 1500 });
  });

  it('rejects out-of-grammar / injection attempts (no eval)', () => {
    expect(safeEvalArithmetic('process.exit(1)').ok).toBe(false);
    expect(safeEvalArithmetic('require("fs")').ok).toBe(false);
    expect(safeEvalArithmetic('2 + alert(1)').ok).toBe(false);
    expect(safeEvalArithmetic('').ok).toBe(false);
  });

  it('rejects division by zero and malformed input', () => {
    expect(safeEvalArithmetic('1 / 0').ok).toBe(false);
    expect(safeEvalArithmetic('2 +').ok).toBe(false);
    expect(safeEvalArithmetic('(1 + 2').ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// claim-typing
// ---------------------------------------------------------------------------
describe('claim typing', () => {
  it('segments an output into atomic claims', () => {
    const claims = segmentClaims('The sum is 4. Also 2 + 2 = 4.\n- Item one\n- Item two');
    expect(claims.length).toBeGreaterThanOrEqual(4);
  });

  it('types arithmetic claims as executable/arithmetic', () => {
    const c = typeClaim('2 + 2 = 4');
    expect(c.type).toBe('executable');
    expect(c.executableKind).toBe('arithmetic');
    expect(c.checkability).toBe(1.0);
    expect(c.parsed).toMatchObject({ lhs: '2 + 2', rhs: '4', relation: 'eq' });
  });

  it('types an on-chain address/tx claim as executable/onchain', () => {
    const addr = typeClaim('The contract 0x8004A818BFB912233c491871b3d84c89A494BD9e is deployed');
    expect(addr.type).toBe('executable');
    expect(addr.executableKind).toBe('onchain');
    const tx = typeClaim(
      'tx 0x6f7cfc07e906d8ca426e81f4ad693e2f5ada9360c3a29244d3a2cf074726330d landed',
    );
    expect(tx.parsed).toMatchObject({ kind: 'tx' });
  });

  it('types a code claim as executable/code but not runnable', () => {
    const c = typeClaim('The function foo returns 42');
    expect(c.type).toBe('executable');
    expect(c.executableKind).toBe('code');
    expect(c.parsed).toMatchObject({ runnable: false });
  });

  it('types a citation as source-grounded', () => {
    const c = typeClaim('See https://example.com/paper for details');
    expect(c.type).toBe('source-grounded');
  });

  it('types a forecast as probabilistic and an opinion as unverifiable', () => {
    expect(typeClaim('BTC will hit $100k next year').type).toBe('probabilistic');
    expect(typeClaim('This design is elegant').type).toBe('unverifiable');
  });
});

// ---------------------------------------------------------------------------
// execution floor — THE LAW
// ---------------------------------------------------------------------------
describe('execution floor — arithmetic primacy', () => {
  it('1. a TRUE math claim executes and passes', async () => {
    const v = await checkClaim(typeClaim('2 + 2 = 4'));
    expect(v.checker).toBe('arithmetic');
    expect(v.executed).toBe(true);
    expect(v.passed).toBe(true);
    expect(v.authoritative).toBe(true);
  });

  it('2. a FALSE math claim executes, fails, and (live) overrides an LLM "pass"', async () => {
    // HAL / an LLM believes the output is clean ("pass").
    const halSaysClean = { decision: 'clean' as const, decision_reason: 'LLM: looks fine' };

    // SHADOW (flag off): decision is NOT changed even though execution proves it false.
    const shadow = await withFlag(undefined, () =>
      applyExecutionFloor('2 + 2 = 5', halSaysClean),
    );
    expect(shadow.floor.hasAuthoritativeFailure).toBe(true);
    expect(shadow.overridden).toBe(false);
    expect(shadow.decision.decision).toBe('clean'); // unchanged in shadow

    // LIVE (flag on): the false, checkable claim overrides the LLM opinion → veto.
    const live = await withFlag('true', () => applyExecutionFloor('2 + 2 = 5', halSaysClean));
    expect(live.overridden).toBe(true);
    expect(live.decision.decision).toBe('vetoed');
    expect(live.decision.decision_reason).toMatch(/EXECUTION FLOOR OVERRIDE/);
    expect(live.decision.decision_reason).toMatch(/inadmissible/);
  });

  it('3. a non-executable claim falls through to HAL untouched (shadow AND live)', async () => {
    const output = 'This architecture is elegant and well designed';
    const halClean = { decision: 'clean' as const };

    const shadow = await withFlag(undefined, () => applyExecutionFloor(output, halClean));
    expect(shadow.overridden).toBe(false);
    expect(shadow.decision.decision).toBe('clean');
    expect(shadow.floor.hasAuthoritativeVerdict).toBe(false);

    // Even LIVE, a non-executable claim can't be overridden by the floor.
    const live = await withFlag('true', () => applyExecutionFloor(output, halClean));
    expect(live.overridden).toBe(false);
    expect(live.decision.decision).toBe('clean');
  });

  it('the floor never LAUNDERS a veto: a passing math line cannot clear an otherwise-vetoed output', async () => {
    const halVeto = { decision: 'vetoed' as const, decision_reason: 'HAL: fabrication elsewhere' };
    const live = await withFlag('true', () => applyExecutionFloor('2 + 2 = 4', halVeto));
    expect(live.overridden).toBe(false);
    expect(live.decision.decision).toBe('vetoed'); // still vetoed
  });
});

// ---------------------------------------------------------------------------
// on-chain path (mocked reader — deterministic, no live RPC)
// ---------------------------------------------------------------------------
describe('execution floor — on-chain lookup (mocked)', () => {
  const KNOWN_CONTRACT = '0x8004A818BFB912233c491871b3d84c89A494BD9e'; // ERC-8004 IdentityRegistry (Base Sepolia)

  it('4. resolves a contract address as a CONTRACT via the injected reader', async () => {
    const mock: OnchainReader = {
      getBalanceWei: async () => 0n,
      getCode: async (addr) => {
        expect(addr.toLowerCase()).toBe(KNOWN_CONTRACT.toLowerCase());
        return '0x363d3d373d3d3d363d73'; // non-empty bytecode ⇒ contract
      },
      txExists: async () => true,
    };
    __setOnchainReader(() => mock);

    const v = await checkClaim(typeClaim(`Contract ${KNOWN_CONTRACT} is deployed`));
    expect(v.checker).toBe('onchain');
    expect(v.executed).toBe(true);
    expect(v.passed).toBe(true);
    expect(v.authoritative).toBe(true);
    expect(v.result).toMatch(/CONTRACT/);
  });

  it('resolves a tx-hash existence claim via the injected reader', async () => {
    __setOnchainReader(() => ({
      getBalanceWei: async () => 0n,
      getCode: async () => '0x',
      txExists: async () => true,
    }));
    const v = await checkClaim(
      typeClaim(
        'tx 0x6f7cfc07e906d8ca426e81f4ad693e2f5ada9360c3a29244d3a2cf074726330d is confirmed',
      ),
    );
    expect(v.executed).toBe(true);
    expect(v.passed).toBe(true);
    expect(v.result).toMatch(/FOUND/);
  });

  it('an RPC failure yields an UNDETERMINED verdict (falls through to HAL, never fabricates)', async () => {
    __setOnchainReader(() => ({
      getBalanceWei: async () => { throw new Error('rpc down'); },
      getCode: async () => { throw new Error('rpc down'); },
      txExists: async () => { throw new Error('rpc down'); },
    }));
    const v = await checkClaim(typeClaim(`Contract 0x8004A818BFB912233c491871b3d84c89A494BD9e exists`));
    expect(v.executed).toBe(false);
    expect(v.passed).toBeNull();
    expect(v.authoritative).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// full-output floor report
// ---------------------------------------------------------------------------
describe('runExecutionFloor over a mixed output', () => {
  it('produces per-claim verdicts and flags an authoritative failure', async () => {
    const output =
      'The total is 2 + 2 = 5. This is a great design. It will probably rain tomorrow.';
    const report = await runExecutionFloor(output);
    expect(report.verdicts.length).toBeGreaterThanOrEqual(3);
    expect(report.hasAuthoritativeFailure).toBe(true); // the 2+2=5 line
  });
});
