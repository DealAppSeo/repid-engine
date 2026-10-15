// Phase 2.10 — VerificationServiceHandler (P-001). runPCP mocked.
const runPCP = jest.fn();
jest.mock('../../src/services/pcp-validator', () => ({ runPCP: (...a: any[]) => runPCP(...a) }));
jest.mock('../../src/services/validation-repid-delta', () => ({ applyServiceFulfilledDeltas: jest.fn() }));
jest.mock('../../src/db', () => ({ db: {} }));
// The chain read goes through the repo's failover wrapper. Mocked so no test reaches a real RPC:
// `node(send)` hands the handler a provider double that answers the way sepolia.base.org would.
const rpcCall = jest.fn();
jest.mock('../../src/clients/rpc-with-failover', () => ({ rpcCall: (...a: any[]) => rpcCall(...a) }));
const node = (send: (...a: any[]) => Promise<unknown>) => (fn: any) =>
  fn({ send, _getConnection: () => ({ url: 'https://sepolia.base.org' }) });

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { VerificationServiceHandler } from '../../src/services/verification-service-handler';

// The living-proof buyer's own rating module, run in a real node, unchanged. A file:// URL, not a
// bare path: ESM rejects `C:\...` on Windows.
const RATER = pathToFileURL(join(__dirname, '..', '..', 'scripts', 'cron', 'rate-deliverable.mjs')).href;
const runNode = (code: string) => execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
const rate = (out: unknown) =>
  JSON.parse(runNode(`import { rateDeliverable } from ${JSON.stringify(RATER)}; process.stdout.write(JSON.stringify(rateDeliverable(${JSON.stringify(out)})));`));
const CLAIM: string = JSON.parse(runNode(`import { CLAIM_TEXT } from ${JSON.stringify(RATER)}; process.stdout.write(JSON.stringify(CLAIM_TEXT));`));
const pcpOk = { score: 1, confidence: 0.95, checked: true, validators: ['a', 'b', 'c'], attemptedValidators: ['a', 'b', 'c'], attemptedCount: 3, respondedCount: 3 };

const contract: any = {
  id: 'c1', provider_agent_id: 'p1', buyer_agent_id: 'buyer1', status: 'escrowed',
  payload: { content: 'The capital of France is Paris.', criteria: ['accuracy'], title: 't' },
};
// The minter's real payload shape: content + acceptance_criteria, no legacy `criteria`.
const daily: any = {
  ...contract,
  payload: { content: CLAIM, title: 'living-proof-1', service_type: 'verification', acceptance_criteria: [{ n: 1, text: 'x' }, { n: 2, text: 'y' }] },
};

describe('VerificationServiceHandler', () => {
  beforeEach(() => {
    rpcCall.mockReset();
    rpcCall.mockImplementation(node(async () => '0x14a34')); // 84532
  });

  it('shapes synthetic taskData (claimed_by=buyer) and emits P-001 PASS', async () => {
    runPCP.mockResolvedValue({ score: 0.9, confidence: 0.8, checked: true, validators: ['a', 'b', 'c'], attemptedValidators: ['a', 'b', 'c'], attemptedCount: 3, respondedCount: 3 });
    const out = await (new VerificationServiceHandler() as any).fulfill(contract);
    const passed = runPCP.mock.calls[0][0];
    expect(passed.claimed_by).toBe('buyer1');
    expect(passed.result).toBe('The capital of France is Paris.');
    expect(out.verdict).toBe('PASS');
    expect(out.confidence).toBe(0.8);
    expect(out.validator_count).toBe(3);
    expect(out.patent_marker).toBe('P-001');
  });

  // CRITERION 2 OF THE DAILY RUN. The living-proof buyer rates this deliverable with the real
  // rate-deliverable.mjs; criterion 2 is "the verdict names the chain id it verified against". The
  // deliverable never named its subject, so that criterion failed on every rated run 2026-09-11..10-14
  // and each scored 0.5 [V prod]. Rated here by the buyer's own module, in a real node, on the minter's
  // real payload shape (content + acceptance_criteria, no legacy `criteria`).
  it('names the claim it verified, so the daily buyer rates every criterion met', async () => {
    runPCP.mockResolvedValue(pcpOk);
    const out = await (new VerificationServiceHandler() as any).fulfill(daily);
    expect(out.claim).toBe(CLAIM);
    expect(rate(out)).toEqual([{ n: 1, met: true }, { n: 2, met: true }]);
  });

  // CRITERION 1, HONESTLY. "PASS" does not say the claim is true: it means the validators were
  // confident, in either direction (prod: "The chemical symbol for gold is Pb." got PASS at score 0).
  // So the deliverable states the claim's truth itself, and says when nothing was read.
  it('states the claim is TRUE/FALSE explicitly; a vote-only claim says it was checked against nothing', async () => {
    const h = new VerificationServiceHandler() as any;
    runPCP.mockResolvedValue({ ...pcpOk, score: 0.9, confidence: 0.8 });
    expect(await h.fulfill(contract)).toMatchObject({ verdict: 'PASS', claim_is: 'TRUE', verified_against: null });
    // Validators sure the claim is wrong: still PASS (a sound deliverable), and the claim is FALSE.
    runPCP.mockResolvedValue({ ...pcpOk, score: 0, confidence: 1 });
    expect(await h.fulfill({ ...contract, payload: { content: 'The chemical symbol for gold is Pb.' } }))
      .toMatchObject({ verdict: 'PASS', claim_is: 'FALSE', verified_against: null });
    // Validators unsure: no truth value is claimed.
    runPCP.mockResolvedValue({ ...pcpOk, score: 0.1, confidence: 0.2 });
    expect(await h.fulfill(contract)).toMatchObject({ verdict: 'FAIL', claim_is: 'UNDETERMINED' });
    expect(rpcCall).not.toHaveBeenCalled(); // not a chain-id claim: nothing is read
  });

  // CRITERION 2, HONESTLY. Echoing the claim puts "84532" in the deliverable without verifying
  // anything. A chain-id claim is now read from the chain, and the verdict rests on that read.
  it('a Base Sepolia chain-id claim is checked with eth_chainId, and the chain decides over the vote', async () => {
    const send = jest.fn(async () => '0x14a34');
    rpcCall.mockImplementation(node(send));
    runPCP.mockResolvedValue({ ...pcpOk, score: 0.2, confidence: 0.3 }); // the vote alone would FAIL
    const out = await (new VerificationServiceHandler() as any).fulfill(daily);
    expect(send).toHaveBeenCalledWith('eth_chainId', []);
    expect(out).toMatchObject({
      claim_is: 'TRUE',
      verdict: 'PASS',
      verified_against: { method: 'eth_chainId', rpc_host: 'sepolia.base.org', returned_chain_id: 84532 },
    });
    expect(Number.isNaN(Date.parse(out.verified_against.at))).toBe(false);
    expect(out.verified_against.error).toBeUndefined();

    // A node answering another id makes the claim FALSE. That is a correct verification, so PASS.
    rpcCall.mockImplementation(node(async () => '0x2105')); // 8453, Base mainnet
    expect(await (new VerificationServiceHandler() as any).fulfill(daily)).toMatchObject({
      claim_is: 'FALSE', verdict: 'PASS', verified_against: { returned_chain_id: 8453 },
    });
  });

  it('an RPC failure is UNDETERMINED with the failure recorded, never a TRUE taken from the vote', async () => {
    runPCP.mockResolvedValue(pcpOk); // the vote is confident; the chain could not be read
    const h = new VerificationServiceHandler() as any;
    rpcCall.mockRejectedValue(new Error('All 3 RPC endpoint(s) failed. Last error: ECONNREFUSED'));
    const down = await h.fulfill(daily);
    expect(down).toMatchObject({
      claim_is: 'UNDETERMINED',
      verdict: 'UNDETERMINED', // not PASS (pays for an unverified claim), not FAIL (blames the provider)
      verified_against: { method: 'eth_chainId', rpc_host: null, returned_chain_id: null },
    });
    expect(down.verified_against.error).toMatch(/ECONNREFUSED/);

    // A node that never answers is bounded, not awaited forever.
    jest.useFakeTimers();
    try {
      rpcCall.mockImplementation(node(() => new Promise(() => {})));
      const pending = h.fulfill(daily);
      await jest.advanceTimersByTimeAsync(5_000);
      expect(await pending).toMatchObject({ claim_is: 'UNDETERMINED', verified_against: { error: expect.stringMatching(/timed out/) } });
    } finally {
      jest.useRealTimers();
    }

    // The configured network is not Base Sepolia: its node is not the chain the claim is about.
    const prior = process.env.NETWORK;
    process.env.NETWORK = 'base';
    rpcCall.mockClear();
    try {
      expect(await h.fulfill(daily)).toMatchObject({ claim_is: 'UNDETERMINED', verified_against: { error: expect.stringMatching(/not Base Sepolia/) } });
      expect(rpcCall).not.toHaveBeenCalled();
    } finally {
      if (prior === undefined) delete process.env.NETWORK; else process.env.NETWORK = prior;
    }
  });

  // THE BUYER'S OWN RATER, unchanged. Before this change an unverified deliverable rated 2/2 (a vote
  // PASS plus the echoed claim). Now both criteria are met only when the chain was actually read.
  it('the daily buyer rates both criteria met only when the chain read happened', async () => {
    runPCP.mockResolvedValue(pcpOk);
    const h = new VerificationServiceHandler() as any;
    expect(rate(await h.fulfill(daily))).toEqual([{ n: 1, met: true }, { n: 2, met: true }]);
    rpcCall.mockRejectedValue(new Error('All 3 RPC endpoint(s) failed'));
    expect(rate(await h.fulfill(daily))).toEqual([{ n: 1, met: false }, { n: 2, met: true }]);
  });

  it('confidence < 0.5 → FAIL (honest verdict, no escalation)', async () => {
    // The validators list is non-empty on purpose. This case previously passed
    // `validators: []` with confidence 0.2 — a shape runPCP can no longer produce,
    // because confidence is now averaged over RESPONDERS. A real FAIL means peers
    // answered and were unconvinced; that is what this asserts.
    runPCP.mockResolvedValue({ score: 0.1, confidence: 0.2, checked: true, validators: ['a', 'b'], attemptedValidators: ['a', 'b', 'c'], attemptedCount: 3, respondedCount: 2 });
    const out = await (new VerificationServiceHandler() as any).fulfill(contract);
    expect(out.verdict).toBe('FAIL');
    expect(out.patent_marker).toBe('P-001');
  });

  // THE REGRESSION THIS PINS. Break it by making fulfill() return a verdict when
  // `checked` is false and this goes red — which is the whole point, because that
  // is what shipped and it disputed twelve consecutive living-proof runs as
  // `provider_at_fault` for work no validator ever assessed.
  it('no validator answered → THROWS NOT_CHECKED, never a FAIL verdict', async () => {
    runPCP.mockResolvedValue({
      score: 0, confidence: 0, checked: false,
      validators: [], attemptedValidators: ['mock-a', 'mock-b', 'mock-c'],
      attemptedCount: 3, respondedCount: 0,
    });
    await expect((new VerificationServiceHandler() as any).fulfill(contract))
      .rejects.toThrow(/NOT_CHECKED/);
  });

  it('an unanswered check never blames the provider', async () => {
    runPCP.mockResolvedValue({
      score: 0, confidence: 0, checked: false,
      validators: [], attemptedValidators: ['mock-a'], attemptedCount: 1, respondedCount: 0,
    });
    let err: Error | undefined;
    try { await (new VerificationServiceHandler() as any).fulfill(contract); }
    catch (e) { err = e as Error; }
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/not the provider's fault/);
    expect(err!.message).not.toMatch(/FAIL/);
  });
});
