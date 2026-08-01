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
 *
 * Hand-rendered HTML with inline CSS on purpose: no build step, no framework,
 * no CDN. It loads on anything and cannot break because a dependency moved.
 */
import { Router, Request, Response } from 'express';
import { buildTrustReceipt, latestRealSettledContractId, type TrustReceipt } from '../../services/trust-receipt';

const router = Router();
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function render(r: TrustReceipt): string {
  const step = (n: number, title: string, body: string) => `
    <div class="step"><div class="n">${n}</div><div><h3>${title}</h3>${body}</div></div>`;

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
        `<p class="muted">${esc(r.zk_proofs[0]!.scheme)} · real=${r.zk_proofs[0]!.is_real}</p>
         <p>Proves a reputation threshold without revealing the score.</p>`)
    : '';

  const caveats = r.caveats.length
    ? `<div class="caveat"><strong>What this receipt does not establish</strong><ul>${r.caveats.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div>`
    : '';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
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
${step(2, 'The money was promised, not paid', `<p>The buyer signed a payment authorisation. Nothing moved yet.</p><p class="muted">An EIP-3009 authorisation is a signature, not a transfer — so this needs no escrow contract and no extra gas.</p>`)}
${step(3, 'The work was checked by someone who did not do it', `<p>Independent verifiers on deliberately different model families reviewed the deliverable.</p><p class="muted">Two copies of one model make the same mistakes, so agreement between them proves nothing.</p>`)}
${step(4, 'Only then was it paid', `<p><strong>${esc(r.price_usdc)} USDC</strong> on Base Sepolia.</p>${r.settlement_url ? `<p><a href="${esc(r.settlement_url)}">${esc(r.settlement_tx)}</a></p>` : '<p class="muted">No settlement on record.</p>'}<p class="muted">simulated: <code>${r.is_simulated}</code> — if this said true, none of it counted.</p>`)}
${rep}
${onchain}
${zk}
${caveats}
<footer>
  <p><strong>The point:</strong> being wrong costs the agent something, and you can verify that yourself on a public chain.</p>
  <p>contract <code>${esc(r.contract_id)}</code> · <a href="/api/v1/receipt/${esc(r.contract_id)}.json">machine-readable</a></p>
</footer></body></html>`;
}

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

router.get('/receipt/:id', async (req: Request, res: Response) => {
  const receipt = await buildTrustReceipt(String(req.params.id));
  if (!receipt) return res.status(404).type('text/plain').send('No such contract.');
  return res.type('html').send(render(receipt));
});

export default router;
