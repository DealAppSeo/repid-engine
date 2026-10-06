/**
 * Verify one ERC-8004 reputation write from the public record alone: the chain and the file the
 * write points at. No key, no database, no trust in our servers beyond fetching the file.
 *
 *   npx ts-node scripts/verify-feedback-write.ts <txHash> [--rpc <url>]
 *
 * Checks, each VERIFIED / NOT_CHECKED / FAILED (src/services/erc8004-feedback-verify.ts):
 *   write     the transaction succeeded, went to the ReputationRegistry and emitted NewFeedback
 *   identity  the agent exists on the IdentityRegistry
 *   file      keccak256 of the file at feedbackURI equals the feedbackHash the write committed to
 *   fields    the file's agentRegistry, agentId, clientAddress, value and tags match the event
 *   payment   the file's proofOfPayment names a real token Transfer from payer to payee
 *
 * Exit 0 VERIFIED, 2 NOT_CHECKED, 1 FAILED. Base Sepolia by default; --rpc or BASE_SEPOLIA_RPC_URL
 * picks the endpoint.
 */
import { lookup } from 'node:dns/promises';
import { ethers } from 'ethers';
import { NETWORKS } from '../src/config/network';
import {
  assessFields,
  assessFile,
  assessIdentity,
  assessPayment,
  assessWrite,
  exitCodeOf,
  FETCH_TIMEOUT_MS,
  fetchTargetProblem,
  isPublicAddress,
  MAX_FILE_BYTES,
  MAX_REDIRECTS,
  overall,
  type DecodedFeedback,
  type Leg,
  type ProofOfPayment,
} from '../src/services/erc8004-feedback-verify';
import reputationAbiRaw from '../src/contracts/ReputationRegistry.abi.json';
import identityAbiRaw from '../src/contracts/IdentityRegistry.abi.json';

const REPUTATION_ABI = (reputationAbiRaw as { abi?: unknown }).abi ?? reputationAbiRaw;
const IDENTITY_ABI = (identityAbiRaw as { abi?: unknown }).abi ?? identityAbiRaw;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * Fetch an attacker-chosen feedbackURI safely (Strix on #1225, CWE-918): public https only, every
 * resolved address public, redirects followed by hand and each hop re-checked, a timeout, and a
 * size cap. Anything refused comes back as an error, which the file leg reports as NOT_CHECKED.
 */
async function fetchFeedbackFile(start: string): Promise<{ status: number; body: Uint8Array } | { error: string }> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const problem = fetchTargetProblem(url);
    if (problem) return { error: `not fetched: ${problem}` };
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    try {
      const addrs = await lookup(host, { all: true });
      const bad = addrs.find((a) => !isPublicAddress(a.address));
      if (addrs.length === 0 || bad) return { error: `not fetched: ${host} resolves to a non-public address` };
    } catch (e) {
      return { error: `could not resolve ${host}: ${e instanceof Error ? e.message : String(e)}` };
    }
    let res: Response;
    try {
      res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location')!, url).toString();
      continue;
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_FILE_BYTES) {
          await reader.cancel();
          return { error: `not fetched: the file is over ${MAX_FILE_BYTES} bytes` };
        }
        chunks.push(value);
      }
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      body.set(c, offset);
      offset += c.byteLength;
    }
    return { status: res.status, body };
  }
  return { error: `not fetched: more than ${MAX_REDIRECTS} redirects` };
}

async function main(): Promise<number> {
  const txHash = process.argv[2];
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    console.error('usage: verify-feedback-write.ts <txHash> [--rpc <url>]');
    return 1;
  }
  const net = NETWORKS['base-sepolia']!;
  const provider = new ethers.JsonRpcProvider(arg('rpc') || process.env.BASE_SEPOLIA_RPC_URL || net.rpcUrl, net.chainId, { staticNetwork: true });
  const registry = net.contracts.reputationRegistry;
  const identityRegistry = net.contracts.identityRegistry;
  const legs: Leg[] = [];

  let receipt: ethers.TransactionReceipt | null = null;
  try {
    receipt = await provider.getTransactionReceipt(txHash);
  } catch (e) {
    console.log(`NOT_CHECKED: the RPC did not answer (${e instanceof Error ? e.message : String(e)})`);
    return 2;
  }
  const iface = new ethers.Interface(REPUTATION_ABI as ethers.InterfaceAbi);
  let decoded: DecodedFeedback | null = null;
  for (const log of receipt?.logs ?? []) {
    if (log.address.toLowerCase() !== registry.toLowerCase()) continue;
    const ev = iface.parseLog({ topics: [...log.topics], data: log.data });
    if (ev?.name !== 'NewFeedback') continue;
    decoded = {
      agentId: ev.args.agentId.toString(),
      clientAddress: ev.args.clientAddress,
      value: ev.args.value.toString(),
      valueDecimals: Number(ev.args.valueDecimals),
      tag1: ev.args.tag1,
      tag2: ev.args.tag2,
      endpoint: ev.args.endpoint,
      feedbackURI: ev.args.feedbackURI,
      feedbackHash: ev.args.feedbackHash,
    };
    break;
  }
  legs.push(assessWrite(receipt ? { status: receipt.status, to: receipt.to } : null, registry, decoded));

  if (decoded) {
    try {
      const identity = new ethers.Contract(identityRegistry, IDENTITY_ABI as ethers.InterfaceAbi, provider);
      legs.push(assessIdentity(await identity.ownerOf!(decoded.agentId), null));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // A revert means the token does not exist; anything else is a read we could not make.
      legs.push(/revert|nonexistent/i.test(msg) ? assessIdentity(null, null) : assessIdentity(null, msg));
    }

    const fetched = await fetchFeedbackFile(decoded.feedbackURI);
    const fileLeg = assessFile(decoded.feedbackHash, fetched);
    legs.push(fileLeg);

    let file: Record<string, unknown> | null = null;
    if (fileLeg.outcome === 'VERIFIED' && 'body' in fetched) {
      file = JSON.parse(Buffer.from(fetched.body).toString('utf8')) as Record<string, unknown>;
    }
    legs.push(assessFields(file, decoded, net.chainId, identityRegistry));

    const proof = (file?.proofOfPayment ?? null) as ProofOfPayment | null;
    let paymentReceipt: Parameters<typeof assessPayment>[1] = null;
    if (proof && String(proof.chainId) === String(net.chainId)) {
      try {
        const r = await provider.getTransactionReceipt(proof.txHash);
        paymentReceipt = r ? { status: r.status, logs: r.logs.map((l) => ({ address: l.address, topics: [...l.topics] })) } : null;
      } catch (e) {
        paymentReceipt = { error: e instanceof Error ? e.message : String(e) };
      }
    }
    legs.push(file ? assessPayment(proof, paymentReceipt, net.chainId) : { leg: 'payment', outcome: 'NOT_CHECKED', detail: 'no verified file to read a proofOfPayment from' });
  }

  for (const l of legs) console.log(`${l.outcome.padEnd(11)} ${l.leg.padEnd(8)} ${l.detail}`);
  const verdict = overall(legs);
  console.log(`\n${verdict}: ${txHash}${decoded ? ` (feedbackURI ${decoded.feedbackURI})` : ''}`);
  return exitCodeOf(verdict);
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
