/**
 * Serve the L1 signing page on 127.0.0.1 for ONE signature, made by the owner in their own wallet
 * (eth_signTypedData_v4). This process never sees a key: the wallet signs, the page posts back only the
 * signature, and this server checks it recovers to the policy's owner before writing anything.
 *
 *   npx ts-node --transpile-only scripts/l1/sign-server.ts --payload <l1-typed-data.json> --experiment <l1-experiment-policy.json>
 *       [--out <dir of the payload>\l1-signed-policy.json] [--port 8790]
 *
 * Refuses to start when the review sheet will not render from these two files. Binds 127.0.0.1 only, answers
 * only requests addressed to 127.0.0.1:<port> from that origin, accepts one signature, then exits.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { policyFromPayload, renderReviewSheet } from '../../src/kernel/l1';
import { verifyOwnerPolicy } from '../../src/kernel/policy';

const arg = (k: string, d?: string): string => {
  const i = process.argv.indexOf(`--${k}`);
  const v = i >= 0 ? process.argv[i + 1] : d;
  if (v === undefined) throw new Error(`--${k} is required`);
  return v;
};

const payloadPath = resolve(arg('payload'));
const payload = readFileSync(payloadPath, 'utf8');
const sheet = renderReviewSheet(payload, readFileSync(resolve(arg('experiment')), 'utf8')); // throws: nothing is served
const parsed = policyFromPayload(payload);
if (!parsed.ok) throw new Error(parsed.error);
const policy = parsed.policy;
const outPath = resolve(arg('out', join(dirname(payloadPath), 'l1-signed-policy.json')));
const port = Number(arg('port', '8790'));
const origin = `http://127.0.0.1:${port}`;
const page = readFileSync(join(__dirname, 'sign.html'), 'utf8');

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((ok, no) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
      if (b.length > 4096) no(new Error('too large'));
    });
    req.on('end', () => ok(b));
    req.on('error', no);
  });

const server = createServer(async (req, res) => {
  const send = (code: number, type: string, body: string) => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'" });
    res.end(body);
  };
  // DNS rebinding: a page on another name that resolves here must not be able to drive this server.
  if (req.headers.host !== `127.0.0.1:${port}`) return send(403, 'text/plain', 'wrong host');
  if (req.method === 'GET' && req.url === '/') return send(200, 'text/html; charset=utf-8', page);
  if (req.method === 'GET' && req.url === '/payload') return send(200, 'text/plain; charset=utf-8', payload);
  if (req.method === 'GET' && req.url === '/info') return send(200, 'application/json', JSON.stringify({ owner: policy.owner, chainIdHex: '0x14a34', digest: parsed.digest, sheet }));
  if (req.method === 'POST' && req.url === '/signature') {
    if (req.headers.origin !== origin || !String(req.headers['content-type']).startsWith('application/json')) return send(403, 'text/plain', 'wrong origin');
    try {
      const { signature } = JSON.parse(await readBody(req)) as { signature?: unknown };
      if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130,}$/.test(signature)) return send(400, 'application/json', JSON.stringify({ ok: false, error: 'not a signature' }));
      // An EOA verifies offline; a smart-wallet owner is checked on Base Sepolia (read-only).
      const v = await verifyOwnerPolicy(policy, signature);
      if (v.status !== 'VERIFIED') return send(400, 'application/json', JSON.stringify({ ok: false, error: `the signature is ${v.status}: ${v.detail}` }));
      writeFileSync(outPath, JSON.stringify({ policy, signature }, null, 2), { flag: 'wx' });
      send(200, 'application/json', JSON.stringify({ ok: true, wrote: outPath, digest: parsed.digest }));
      console.log(`VERIFIED (${v.kind}). Wrote ${outPath}\nEIP-712 digest ${parsed.digest}\nThe server stops now.`);
      setTimeout(() => process.exit(0), 200);
    } catch (e) {
      send(400, 'application/json', JSON.stringify({ ok: false, error: String((e as Error).message).slice(0, 200) }));
    }
    return;
  }
  send(404, 'text/plain', 'not found');
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Open ${origin}/ in the browser where your wallet is installed.`);
  console.log(`Owner that must sign: ${policy.owner}`);
  console.log(`EIP-712 digest: ${parsed.digest}`);
});
