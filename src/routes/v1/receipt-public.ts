/**
 * receipt-public.ts — the shareable proof that the trust harness did its job.
 *
 * PUBLIC and unauthenticated by design. The whole argument is "you can check
 * this without trusting us", and a receipt behind an API key does not make that
 * argument. Everything served is either already on-chain and world-readable or
 * a fact ABOUT the exchange — never the work itself (see trust-receipt.ts).
 *
 * Read-only. No writes, no side effects, no secrets.
 *
 *   GET /api/v1/receipt/latest        -> newest REAL settled exchange (HTML)
 *   GET /api/v1/receipt/:id           -> that exchange (HTML)
 *   GET /api/v1/receipt/:id.json      -> the same data, machine-readable
 *   GET /api/v1/receipt/:id/proof/:job -> one linked Plonky3 proof: bytes, statement, and a
 *                                         server-side verification. No API key.
 *
 * Hand-rendered HTML with inline CSS on purpose: no build step, no framework,
 * no CDN. It loads on anything and cannot break because a dependency moved.
 */
import { Router, Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { trustedClientIp } from '../../middleware/client-ip';
import { buildTrustReceipt, latestRealSettledContractId, type TrustReceipt } from '../../services/trust-receipt';
import { db } from '../../db';
import { verifyRangeCheck } from '../../zkp/range-check-verify';

const router = Router();
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const step = (n: number, title: string, body: string) => `
    <div class="step"><div class="n">${n}</div><div><h3>${title}</h3>${body}</div></div>`;

/**
 * Steps 2 and 4 used to state, for every exchange, that the money was held and
 * released only after verified delivery. That is the product's central claim,
 * and it was not true of every row: exchanges before 2026-08-01 settled at
 * ESCROW. Contract 18dd4e05 paid at 04:32:31.72 and was fulfilled at 04:33:23.54
 * — 52 seconds LATER. Rendering the pay-on-delivery story over that data would
 * be the exact failure this receipt exists to expose, printed on the page that
 * exists to prove we do not do it.
 *
 * The narrative now follows `paid_before_delivery`, which is derived from the
 * timestamps. An older exchange still gets a receipt; it gets the true one.
 */
function payFlow(r: TrustReceipt): string {
  if (r.paid_before_delivery === true) {
    return step(2, 'The money moved up front — this one was not delivery-gated',
      `<p>Payment settled when the contract was escrowed, <strong>before</strong> the work was delivered.</p>
       <p class="muted">Delivery-gated settlement landed on 2026-08-01. This exchange predates it, so the buyer carried the risk. Shown rather than smoothed over.</p>`);
  }
  if (r.paid_before_delivery === null) {
    return step(2, 'Payment timing could not be established',
      `<p class="muted">One of the two timestamps needed to say whether payment preceded delivery is missing, so this receipt does not claim either way.</p>`);
  }
  return step(2, 'The money was promised, not paid',
    `<p>The buyer signed a payment authorisation. Nothing moved yet.</p>
     <p class="muted">An EIP-3009 authorisation is a signature, not a transfer — so this needs no escrow contract and no extra gas.</p>`);
}

function paidStep(r: TrustReceipt): string {
  const tx = r.settlement_url
    ? `<p><a href="${esc(r.settlement_url)}">${esc(r.settlement_tx)}</a></p>`
    : '<p class="muted">No settlement on record.</p>';
  const sim = `<p class="muted">simulated: <code>${r.is_simulated}</code> — if this said true, none of it counted.</p>`;
  // The settlement RECORD's wallets, labelled as such: this page does not re-read the on-chain transfer
  // (XC1 review of #1386). The settlement tx link below is where anyone can check them.
  const wallets = r.payer_wallet && r.payee_wallet
    ? `<p>Recorded payer <code>${esc(r.payer_wallet)}</code> (${esc(r.buyer)}) and payee <code>${esc(r.payee_wallet)}</code> (${esc(r.provider)}).</p>` +
      '<p class="muted">As the settlement record names them. This page does not re-read the transfer on chain: check the transaction below.</p>'
    : '';
  const title = r.paid_before_delivery === false ? 'Only then was it paid' : 'The payment';
  return step(4, title, `<p><strong>${esc(r.price_usdc)} USDC</strong> on Base Sepolia.</p>${wallets}${tx}${sim}`);
}

/**
 * The agreed spec, as text. Step 8 says "recompute it yourself", but the page carried only the hash;
 * the preimage lived behind the JSON link. It is an object, so it is rendered field by field and never
 * interpolated (that prints "[object Object]"). Each criterion shows the buyer's rating beside it.
 */
function workStatement(r: TrustReceipt): string {
  const ws = r.work_statement as { deliverable?: unknown; acceptance_criteria?: unknown } | null;
  if (!ws || typeof ws !== 'object') return '';
  const ratings = Array.isArray(r.criterion_ratings) ? (r.criterion_ratings as Array<{ n?: unknown; met?: unknown }>) : [];
  const met = new Map(ratings.map((x) => [Number(x?.n), x?.met]));
  const criteria = (Array.isArray(ws.acceptance_criteria) ? ws.acceptance_criteria : []) as Array<{ n?: unknown; text?: unknown }>;
  const items = criteria
    .map((c) => {
      const m = met.get(Number(c?.n));
      const verdict = m === true ? 'met' : m === false ? 'not met' : 'not rated';
      return `<li value="${Number(c?.n) || ''}">${esc(c?.text)} <span class="muted">— ${verdict}</span></li>`;
    })
    .join('');
  return `<p><strong>Agreed deliverable:</strong> ${esc(ws.deliverable)}</p>${items ? `<ol>${items}</ol>` : ''}`;
}

/**
 * Step 3 used to say, on every receipt, "Independent verifiers on deliberately different model
 * families reviewed the deliverable". MEASURED 2026-10-16: 14 of 16 daily receipts were reviewed by
 * `trinity-mock-*` agents, no validator of any of them has a recorded model family, and on one
 * (e12e52c7) the provider was one of its own validators. So the step says only what the record says.
 */
function checkedStep(r: TrustReceipt): string {
  const v = r.validators;
  if (!v) return step(3, 'No validator record', '<p class="muted">This exchange records no validators, so this receipt makes no claim about who checked the work.</p>');
  const title = v.includes_provider
    ? 'The work was reviewed, and the provider was one of its own validators'
    : 'The work was checked by validators other than the provider';
  const families = v.families.length >= 2
    ? `<p>Recorded model families of the validators: ${v.families.map(esc).join(', ')}.</p><p class="muted">Two copies of one model make the same mistakes, so agreement between them proves nothing.</p>`
    : v.families.length === 1
      ? `<p>Only one validator model family is recorded: ${esc(v.families[0])}. Agreement between copies of one model is weak evidence.</p>`
      : '<p class="muted">No validator model family is recorded, so this receipt does not claim the validators were independent of each other.</p>';
  return step(3, title, families);
}

/**
 * True only when a proof listed on this receipt was recorded against this exchange's work-statement
 * hash. `work_statement_hash` on a proof entry is read structurally: proof entries gain it with the E1
 * proof-link change (#1418). Without that change no proof is linked to any contract, so false is the
 * truth here, not a gap.
 */
function proofForThisWork(r: TrustReceipt): boolean {
  return !!r.work_statement_hash &&
    r.zk_proofs.some((p) => (p as { work_statement_hash?: unknown }).work_statement_hash === r.work_statement_hash);
}

function render(r: TrustReceipt): string {

  const negotiation = r.negotiated
    ? step(1, 'The price was negotiated, not announced',
        `<p>${r.competing_bids} providers bid against each other. ${
          r.won_on_price
            ? 'The cheapest won.'
            : 'A dearer bid won — and had to justify itself in writing, enforced by a database constraint.'
        }</p><p class="muted">The buyer never named the price. It was read from the winning bid, server-side. Every losing bid is retained.</p>`)
    : step(1, 'Fixed listing price', `<p class="muted">This exchange predates negotiated pricing.</p>`);

  const rep = r.reputation_events.length
    ? step(5, 'Reputation moved — both sides, earned not asserted',
        `<table>${r.reputation_events
          .map((e) => `<tr><td>${esc(e.agent)}</td><td class="muted">${esc(e.event)}</td><td class="${e.delta >= 0 ? 'up' : 'down'}">${e.delta >= 0 ? '+' : ''}${e.delta}</td><td class="muted">${e.from} → ${e.to}</td></tr>`)
          .join('')}</table>`)
    : '';

  const onchain = r.onchain_url
    ? step(6, 'Written where we cannot edit it',
        `<p>Reputation <strong>${r.onchain_repid}</strong> recorded on Base Sepolia via ERC-8004, caused by this contract.</p>
         <p><a href="${esc(r.onchain_url)}">${esc(r.onchain_tx)}</a></p>
         <p class="muted">Not our database. Anyone can verify it without asking us.</p>`)
    : '';

  const zk = r.zk_proofs.length
    ? step(7, 'Zero-knowledge proof attached',
        `<ul>${r.zk_proofs
          .map((p) => `<li>${esc(p.agent)} · ${esc(p.scheme)} · real=${p.is_real}${
            p.proof_url ? ` · <a href="${esc(p.proof_url)}">verify</a>` : ''
          }</li>`)
          .join('')}</ul>
         <p>Proves a reputation threshold. The score, threshold and agent id are public inputs bound by the proof — tamper-evident, not hidden.</p>
         <p class="muted">Each verify link returns the proof bytes and statement and checks them on our server. No API key. To check without trusting us, run them through <code>@hyperdag/proof-verifier</code>.</p>`)
    : '';

  // "This proof is bound to THIS work" was printed whenever a hash existed, including on every
  // receipt that showed no proof at all. It is now said only when a listed proof carries this hash,
  // and even then as "recorded against": the proof attests a RepID threshold and does not commit to
  // the hash (abf897cf: linking is provenance, not proof the work was done).
  const hashFacts = `<p class="muted"><code>${esc(r.work_statement_hash)}</code></p>
         ${workStatement(r)}
         <p>A commitment over this exchange's immutable facts, recorded at settlement. Recompute it yourself and it must match, so the facts cannot be edited afterwards without the hash disagreeing.</p>`;
  const binding = !r.work_statement_hash
    ? ''
    : proofForThisWork(r)
      ? step(8, 'This proof is recorded against THIS work', `${hashFacts}
         <p>The proof's record carries this same hash.</p>
         <p class="muted">The proof attests a reputation threshold. It does not commit to this hash, and it does <strong>not</strong> assert the work was correct.</p>`)
      : step(8, 'The agreed work, fingerprinted', `${hashFacts}
         <p class="muted">No proof on this receipt is recorded against this hash.</p>`);

  const caveats = r.caveats.length
    ? `<div class="caveat"><strong>What this receipt does not establish</strong><ul>${r.caveats.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div>`
    : '';

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Trust receipt — ${esc(r.buyer)} paid ${esc(r.provider)} ${esc(r.price_usdc)}</title>
<style>
 :root{color-scheme:light dark}
 body{font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;max-width:44rem;margin:0 auto;padding:2rem 1.25rem;background:#fbfbfa;color:#1a1a18}
 @media(prefers-color-scheme:dark){body{background:#16161a;color:#e8e8e6}.step{background:#1f1f24!important;border-color:#2e2e35!important}.caveat{background:#2a2418!important}}
 h1{font-size:1.45rem;margin:0 0 .25rem}
 .flow{font-size:1.15rem;margin:1.5rem 0;padding:1rem;border:1px solid #e2e2dd;border-radius:.6rem;text-align:center}
 .step{display:flex;gap:1rem;background:#fff;border:1px solid #e8e8e3;border-radius:.6rem;padding:1rem;margin:.75rem 0}
 .step h3{margin:.1rem 0 .4rem;font-size:1rem}
 .step p{margin:.3rem 0}
 .n{flex:0 0 1.6rem;height:1.6rem;border-radius:50%;background:#1a1a18;color:#fff;display:grid;place-items:center;font-size:.85rem}
 @media(prefers-color-scheme:dark){.n{background:#e8e8e6;color:#16161a}}
 .muted{opacity:.66;font-size:.92rem}
 table{width:100%;border-collapse:collapse;font-size:.92rem}td{padding:.2rem .4rem}
 .up{color:#1a7f37;font-weight:600}.down{color:#b42318;font-weight:600}
 a{color:inherit;word-break:break-all}
 .caveat{background:#fdf6e3;border-radius:.6rem;padding:.9rem 1rem;margin:1rem 0;font-size:.92rem}
 .caveat ul{margin:.4rem 0 0;padding-left:1.1rem}
 footer{margin-top:2rem;font-size:.85rem;opacity:.6}
 code{font-size:.85rem}
</style></head><body>
<h1>Trust receipt</h1>
<p class="muted">One agent hired another. Every claim below is checkable without trusting us.</p>
<div class="flow"><strong>${esc(r.buyer)}</strong> &nbsp;──&nbsp; ${esc(r.price_usdc)} &nbsp;──▶&nbsp; <strong>${esc(r.provider)}</strong></div>
${negotiation}
${payFlow(r)}
${checkedStep(r)}
${paidStep(r)}
${rep}
${onchain}
${zk}
${binding}
${caveats}
<footer>
  <p><strong>The point:</strong> being wrong costs the agent something, and you can verify that yourself on a public chain.</p>
  <p>contract <code>${esc(r.contract_id)}</code> · <a href="/api/v1/receipt/${esc(r.contract_id)}.json">machine-readable</a></p>
</footer></body></html>`;
  // Number the steps in the order shown. Steps 5-8 drop out when their data is missing, and fixed
  // numbers left a gap (6 then 8 on every receipt with no proof).
  let n = 0;
  return html.replace(/<div class="n">\d+<\/div>/g, () => `<div class="n">${++n}</div>`);
}

/**
 * `/receipt/latest.json` MUST be declared before `/receipt/:id.json`, or Express
 * matches the parameterised route with id="latest", buildTrustReceipt looks up a
 * contract called "latest", finds nothing, and returns 404.
 *
 * That is exactly what shipped: I documented "add .json to any receipt URL" and
 * the alias 404'd in production. Found by an independent red-team pass, not by
 * me — the documented contract and the deployed behaviour disagreed, which is
 * the failure mode this whole project is supposed to be about.
 */
router.get('/receipt/latest.json', async (_req: Request, res: Response) => {
  const id = await latestRealSettledContractId();
  if (!id) return res.status(404).json({ error: 'no_settled_exchange', message: 'No real settled exchange yet. This endpoint will not invent one.' });
  const receipt = await buildTrustReceipt(id);
  if (!receipt) return res.status(404).json({ error: 'not_found' });
  return res.json(receipt);
});

router.get('/receipt/latest', async (_req: Request, res: Response) => {
  const id = await latestRealSettledContractId();
  if (!id) return res.status(404).type('text/plain').send('No real settled exchange yet. This page will not invent one.');
  const receipt = await buildTrustReceipt(id);
  if (!receipt) return res.status(404).type('text/plain').send('Not found.');
  return res.type('html').send(render(receipt));
});

router.get('/receipt/:id.json', async (req: Request, res: Response) => {
  const receipt = await buildTrustReceipt(String(req.params.id));
  if (!receipt) return res.status(404).json({ error: 'not_found' });
  return res.json(receipt);
});

/**
 * One proof linked to this contract, with its bytes, its statement and a server-side verification.
 * Keyless on purpose: the by-job route under /agents needs an API key, so a stranger reading a
 * receipt could see a proof listed and not check it. Only a proof the receipt itself lists is served,
 * so this cannot be used to browse proofs unrelated to the contract.
 */
// Keyless, and each call runs the receipt queries plus a WASM verify, so it is metered per network
// address (trustedClientIp, as bounties.ts does). CodeQL js/missing-rate-limiting.
export const PROOF_CHECK_LIMIT_PER_MIN = 30;
const proofCheckLimiter = rateLimit({
  windowMs: 60_000,
  limit: PROOF_CHECK_LIMIT_PER_MIN,
  keyGenerator: (req): string => ipKeyGenerator(trustedClientIp(req)),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests' },
});

router.get('/receipt/:id/proof/:jobId', proofCheckLimiter, async (req: Request, res: Response) => {
  const receipt = await buildTrustReceipt(String(req.params.id));
  if (!receipt) return res.status(404).json({ error: 'not_found' });
  const jobId = String(req.params.jobId);
  const linked = receipt.zk_proofs.find((p) => p.job_id === jobId);
  if (!linked) return res.status(404).json({ error: 'proof_not_linked', message: 'No proof with this job id is linked to this contract.' });

  // Newest row for the job, the same row linkedProofs picked for the receipt.
  const { data: row } = await db
    .from('repid_zkp_proofs')
    .select('proof_bytes, statement, scheme')
    .eq('job_id', jobId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const proofBytes = typeof row?.proof_bytes === 'string' && row.proof_bytes ? row.proof_bytes : null;
  const statement = row?.statement && typeof row.statement === 'object' && !Array.isArray(row.statement)
    ? (row.statement as Record<string, unknown>)
    : null;
  const verification = row?.scheme === 'plonky3_range_check' && proofBytes && statement
    ? verifyRangeCheck(proofBytes, statement)
    : { verified: false, error: 'not a plonky3_range_check row with proof bytes and a statement' };

  return res.json({
    contract_id: receipt.contract_id,
    ...linked,
    proof_bytes: proofBytes,
    verification,
  });
});

router.get('/receipt/:id', async (req: Request, res: Response) => {
  const receipt = await buildTrustReceipt(String(req.params.id));
  if (!receipt) return res.status(404).type('text/plain').send('No such contract.');
  return res.type('html').send(render(receipt));
});

export default router;
