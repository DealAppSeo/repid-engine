/**
 * Signed HAL receipts: three verdicts, an id that resolves, a signature a third party checks with
 * only the receipt and a public key, and a provider failure that is a reason-coded NOT_CHECKED.
 * No network, no database. The key is a throwaway generated per run.
 */
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { buildHalReceipt, checkHalReceipt, signedHalReceipt, failureCode, type SignedHalReceipt } from '../src/hal/signed-verdict-receipt';
import { withVerdictReceiptId } from '../src/hal/verdict-receipt-id';
import { signerFromPublicKey } from '../src/kernel/receipt-signing';
import receiptVerifyRouter from '../src/routes/receipt-verify';

const VERIFIER = path.join(__dirname, '..', 'eval', 'hal-receipts', 'verify-receipt.mjs');
const fixtures = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'hal-receipt-claims.json'), 'utf8')) as {
  cases: Array<{ id: string; text: string; near_miss: string; decision: string; families: string[]; votes: string[][]; expect: { verdict: string; reason: string } }>;
};

function halResponse(c: (typeof fixtures.cases)[number]) {
  return {
    decision: c.decision,
    hal_score: c.decision === 'vetoed' ? 0.9 : 0.1,
    mode: 'fact-check',
    strictness: 2,
    signals: { families_used: c.families.length, families: c.families },
    provider_responses: c.votes.map(([provider, model, verdict, error]) => ({ provider, model, verdict, confidence: 80, latency_ms: 10, note: `${provider} says ${verdict}`, ...(error ? { error } : {}) })),
  };
}

function freshKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pub = '0x' + Buffer.from(String(publicKey.export({ format: 'jwk' }).x), 'base64url').toString('hex');
  return { pkcs8: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), pub };
}

const saved = { ...process.env };
afterEach(() => {
  for (const k of ['KERNEL_RECEIPT_SIGNING_KEY', 'KERNEL_RECEIPT_TRUSTED_SIGNERS', 'HAL_SIGNED_RECEIPT_ENABLED', 'HAL_SIGNED_RECEIPT_VERIFY_ENABLED', 'HAL_VERDICT_RECEIPT_ID_ENABLED']) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function standalone(receipt: unknown, pub: string, claim?: string): { verified: boolean; reason?: string; verdict?: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'halr-'));
  writeFileSync(path.join(dir, 'r.json'), JSON.stringify(receipt));
  const args = [VERIFIER, path.join(dir, 'r.json'), pub];
  if (claim !== undefined) {
    writeFileSync(path.join(dir, 'c.txt'), claim);
    args.push(path.join(dir, 'c.txt'));
  }
  try {
    return JSON.parse(execFileSync('node', args, { encoding: 'utf8' }));
  } catch (e: any) {
    return JSON.parse(String(e.stdout));
  }
}

describe('signed HAL receipt — fixtures', () => {
  const key = freshKey();
  beforeEach(() => { process.env.KERNEL_RECEIPT_SIGNING_KEY = key.pkcs8; });

  it.each(fixtures.cases.map((c) => [c.id, c] as const))('%s: verdict, id, signature, claim binding', (_id, c) => {
    const r = signedHalReceipt(c.text, halResponse(c));
    expect({ verdict: r.verdict, reason: r.reason }).toEqual(c.expect);
    expect(r.receipt_id).toMatch(/^halr1_[0-9a-f]{64}$/);
    // in-repo check and the standalone script agree, and both bind the exact claim text
    expect(checkHalReceipt(r, [signerFromPublicKey(key.pub)!], c.text)).toMatchObject({ verified: true, verdict: c.expect.verdict });
    expect(standalone(r, key.pub, c.text)).toMatchObject({ verified: true, verdict: c.expect.verdict });
    expect(standalone(r, key.pub, c.near_miss)).toEqual({ verified: false, reason: 'claim_mismatch' });
    // no claim text and no raw provider error ever enter the receipt
    expect(JSON.stringify(r)).not.toContain(c.text);
    expect(JSON.stringify(r)).not.toMatch(/Payment Required|rate limit/);
  });

  it('a near-miss claim gets a different receipt id (negation, workflow name, first attempt)', () => {
    for (const c of fixtures.cases) {
      expect(buildHalReceipt(c.text, halResponse(c)).receipt_id).not.toBe(buildHalReceipt(c.near_miss, halResponse(c)).receipt_id);
    }
  });
});

describe('signed HAL receipt — tamper and trust', () => {
  const key = freshKey();
  const other = freshKey();
  const c = fixtures.cases[0]!;
  let r: SignedHalReceipt;
  beforeEach(() => {
    process.env.KERNEL_RECEIPT_SIGNING_KEY = key.pkcs8;
    r = signedHalReceipt(c.text, halResponse(c));
  });

  it('flipping the verdict breaks the id', () => {
    expect(standalone({ ...r, verdict: 'SUPPORTED' }, key.pub).reason).toBe('receipt_id_mismatch');
  });

  it('a forger who recomputes the id still cannot produce the signature', () => {
    const forged = buildHalReceipt(c.text, { ...halResponse(c), decision: 'clean' });
    const withOldSig = { ...forged, signer: r.signer, signature: r.signature };
    expect(standalone(withOldSig, key.pub).reason).toBe('bad_signature');
    expect(checkHalReceipt(withOldSig, [signerFromPublicKey(key.pub)!])).toEqual({ verified: false, reason: 'bad_signature' });
  });

  it('a receipt signed by a key nobody pinned is untrusted, even if internally valid', () => {
    process.env.KERNEL_RECEIPT_SIGNING_KEY = other.pkcs8;
    const rogue = signedHalReceipt(c.text, halResponse(c));
    expect(checkHalReceipt(rogue, [signerFromPublicKey(key.pub)!])).toEqual({ verified: false, reason: 'untrusted_signer' });
    expect(standalone(rogue, key.pub).reason).toBe('untrusted_signer');
  });
});

describe('NOT_CHECKED is never a pass or a zero-score fail', () => {
  const base = { hal_score: 0, strictness: 2, signals: { families_used: 3, families: ['a', 'b', 'c'] } };
  const ok = [{ provider: 'p', model: 'm', verdict: 'FALSE' }];
  it.each([
    ['extractor fallback', { ...base, decision: 'clean', mode: 'extractor-fallback', provider_responses: ok }, 'not_fact_check_mode:extractor-fallback'],
    ['no votes at all', { ...base, decision: 'clean', mode: 'fact-check', provider_responses: [] }, 'all_providers_failed'],
    ['abstain', { ...base, decision: 'abstain', mode: 'fact-check', provider_responses: ok }, 'abstain'],
    ['one family', { ...base, decision: 'vetoed', mode: 'fact-check', signals: { families_used: 1 }, provider_responses: ok }, 'under_quorum:1_families'],
    ['veto nobody voted FALSE for', { ...base, decision: 'vetoed', mode: 'fact-check', provider_responses: [{ provider: 'p', model: 'm', verdict: 'UNCERTAIN' }] }, 'veto_without_false_vote'],
  ])('%s', (_n, v, reason) => {
    const r = buildHalReceipt('x', v as any);
    expect(r.verdict).toBe('NOT_CHECKED');
    expect(r.reason).toBe(reason);
  });

  it('failure codes', () => {
    expect(failureCode('HTTP 402 Payment Required')).toBe('provider_refused_credit');
    expect(failureCode('403 Forbidden')).toBe('provider_refused_credit');
    expect(failureCode('429 Too Many Requests')).toBe('rate_limited');
    expect(failureCode('The operation was aborted')).toBe('timeout');
    expect(failureCode('weird')).toBe('provider_error');
  });

  it('flag on, no signing key: unsigned and NOT_CHECKED, with an id that still resolves', () => {
    delete process.env.KERNEL_RECEIPT_SIGNING_KEY;
    const c = fixtures.cases[0]!;
    const r = signedHalReceipt(c.text, halResponse(c));
    expect(r.verdict).toBe('NOT_CHECKED');
    expect(r.reason).toBe('signing_key_unset,would_be:CONTRADICTED');
    expect(r.signature).toBeUndefined();
    expect(standalone(r, freshKey().pub).reason).toBe('unsigned');
  });
});

describe('receipt verdict and the eval ruler agree on every shape', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { isNotCheckedV3, predictedHallucination } = require('../scripts/hal-eval/metrics');
  const modes = ['fact-check', 'extractor-fallback'];
  const decisions = ['clean', 'flagged', 'vetoed', 'abstain'];
  const voteSets = [[], ['ERROR'], ['TRUE', 'TRUE'], ['FALSE', 'UNCERTAIN'], ['UNCERTAIN', 'UNCERTAIN'], ['FALSE', 'ERROR']];
  it('NOT_CHECKED iff isNotCheckedV3; CONTRADICTED iff checked and vetoed', () => {
    let n = 0;
    for (const mode of modes) for (const decision of decisions) for (const vs of voteSets) for (const fam of [0, 1, 2, 3]) {
      const v = { decision, hal_score: 0.5, mode, strictness: 2, signals: { families_used: fam }, provider_responses: vs.map((verdict, i) => ({ provider: `p${i}`, model: 'm', verdict })) };
      const r = buildHalReceipt('x', v);
      const votes = vs.reduce<Record<string, number>>((a, k) => ((a[k] = (a[k] ?? 0) + 1), a), {});
      const nc = isNotCheckedV3({ verdict: decision, mode, votes, familiesUsed: fam }) || vs.length === 0 || vs.every((x) => x === 'ERROR');
      expect([decision, mode, vs.join('+'), fam, r.verdict === 'NOT_CHECKED']).toEqual([decision, mode, vs.join('+'), fam, nc]);
      if (!nc) expect(r.verdict).toBe(predictedHallucination(decision) ? 'CONTRADICTED' : 'SUPPORTED');
      n++;
    }
    expect(n).toBe(192);
  });
});

describe('wiring is default-off', () => {
  const c = fixtures.cases[3]!;
  it('withVerdictReceiptId with both flags off returns the same object', () => {
    const body = halResponse(c);
    expect(withVerdictReceiptId(c.text, body)).toBe(body);
  });

  it('HAL_SIGNED_RECEIPT_ENABLED=true attaches signed_receipt; the id flag stays independent', () => {
    process.env.HAL_SIGNED_RECEIPT_ENABLED = 'true';
    process.env.KERNEL_RECEIPT_SIGNING_KEY = freshKey().pkcs8;
    const out = withVerdictReceiptId(c.text, halResponse(c)) as any;
    expect(out.signed_receipt.verdict).toBe('SUPPORTED');
    expect(out.receipt_id).toBeUndefined();
    expect(out.signed_receipt.verdict_receipt_id).toMatch(/^halv1_/);
  });

  it('POST /api/v1/receipt/verify: unchanged when off; signature_check against the pin when on', async () => {
    const key = freshKey();
    process.env.KERNEL_RECEIPT_SIGNING_KEY = key.pkcs8;
    const signed_receipt = signedHalReceipt(c.text, halResponse(c));
    const app = express();
    app.use(express.json());
    app.use('/api/v1', receiptVerifyRouter);

    const off = await request(app).post('/api/v1/receipt/verify').send({ receipt_id: 'x', signed_receipt });
    expect(off.body).toEqual({ receipt_id: 'x', families: [] });

    process.env.HAL_SIGNED_RECEIPT_VERIFY_ENABLED = 'true';
    const unpinned = await request(app).post('/api/v1/receipt/verify').send({ receipt_id: 'x', signed_receipt });
    expect(unpinned.body.signature_check).toEqual({ verified: false, reason: 'untrusted_signer' });

    process.env.KERNEL_RECEIPT_TRUSTED_SIGNERS = key.pub;
    const pinned = await request(app).post('/api/v1/receipt/verify').send({ receipt_id: 'x', signed_receipt });
    expect(pinned.body.signature_check).toMatchObject({ verified: true, verdict: 'SUPPORTED', receipt_id: signed_receipt.receipt_id });
  });
});
