// Phase 2.10 — VerificationServiceHandler (P-001). runPCP mocked.
const runPCP = jest.fn();
jest.mock('../../src/services/pcp-validator', () => ({ runPCP: (...a: any[]) => runPCP(...a) }));
jest.mock('../../src/services/validation-repid-delta', () => ({ applyServiceFulfilledDeltas: jest.fn() }));
jest.mock('../../src/db', () => ({ db: {} }));

import { VerificationServiceHandler } from '../../src/services/verification-service-handler';

const contract: any = {
  id: 'c1', provider_agent_id: 'p1', buyer_agent_id: 'buyer1', status: 'escrowed',
  payload: { content: 'The capital of France is Paris.', criteria: ['accuracy'], title: 't' },
};

describe('VerificationServiceHandler', () => {
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
    runPCP.mockResolvedValue({ score: 1, confidence: 0.95, checked: true, validators: ['a', 'b', 'c'], attemptedValidators: ['a', 'b', 'c'], attemptedCount: 3, respondedCount: 3 });
    const { join } = require('node:path');
    const { pathToFileURL } = require('node:url');
    const { execFileSync } = require('node:child_process');
    // A file:// URL, not a bare path: ESM rejects `C:\...` on Windows.
    const mod = pathToFileURL(join(__dirname, '..', '..', 'scripts', 'cron', 'rate-deliverable.mjs')).href;
    const run = (code: string) => execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
    const claim = JSON.parse(run(`import { CLAIM_TEXT } from ${JSON.stringify(mod)}; process.stdout.write(JSON.stringify(CLAIM_TEXT));`));
    const daily: any = {
      ...contract,
      payload: { content: claim, title: 'living-proof-1', service_type: 'verification', acceptance_criteria: [{ n: 1, text: 'x' }, { n: 2, text: 'y' }] },
    };
    const out = await (new VerificationServiceHandler() as any).fulfill(daily);
    expect(out.claim).toBe(claim);
    const ratings = JSON.parse(run(`import { rateDeliverable } from ${JSON.stringify(mod)}; process.stdout.write(JSON.stringify(rateDeliverable(${JSON.stringify(out)})));`));
    expect(ratings).toEqual([{ n: 1, met: true }, { n: 2, met: true }]);
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
