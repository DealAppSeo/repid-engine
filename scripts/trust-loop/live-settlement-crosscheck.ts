/**
 * live-settlement-crosscheck.ts — the one measurement the settlement path is missing.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT IS ALREADY MEASURED, SO THIS DOES NOT REDO IT
 * ════════════════════════════════════════════════════════════════════════════════
 * `tests/x402-settlement-verifier.test.ts` runs the whole accept/reject matrix against
 * a fake provider and it is in CI: a confirmed payment verifies; an unknown hash, a
 * reverted tx, a transfer to the wrong address, a transfer of the wrong token, a
 * spoofed `Transfer` from a non-token contract, insufficient confirmations and a
 * claimed value above the money that moved all fail — and an RPC outage comes back
 * `NOT_CHECKED` rather than as a verdict.
 *
 * What that proves is that the DECISION LOGIC is right. It says nothing about whether
 * the RPC endpoint, the configured USDC address and the log encoding a real Base
 * Sepolia receipt actually carries line up.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE GAP THIS CLOSES
 * ════════════════════════════════════════════════════════════════════════════════
 * A fake provider returns exactly the receipt shape the test author imagined. Three
 * things can differ on the real chain and every one of them would make an honest
 * settlement look unverified:
 *
 *   1. `config.usdcTokenAddress` points at the wrong contract for this network, so
 *      every genuine transfer reads as "a different token".
 *   2. `config.baseSepoliaRpc` is unset, rate-limited, or pruned, so receipts come
 *      back null and every settlement reads as "not found on chain" — which the
 *      verifier reports as MEASURED, because a chain that answers "no such tx" IS an
 *      observation. That is correct behaviour and exactly why a misconfigured
 *      endpoint is dangerous: it produces confident wrong answers, not errors.
 *   3. The token emits `Transfer` through a proxy whose log `address` is not the one
 *      configured, so the emitter check — the load-bearing one — rejects real logs.
 *
 * Until this runs green against a real receipt, the live settlement path is
 * NOT_CHECKED. Not FAILED, and emphatically not MEASURED.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHY IT IS A SCRIPT AND NOT A TEST
 * ════════════════════════════════════════════════════════════════════════════════
 * It needs egress to a Base Sepolia RPC, which the agent sandbox denies (CONNECT 403,
 * verified 2026-08-21) and which CI should not depend on either — a gate that reddens
 * for environmental reasons gets ignored within a week, at which point it is worse
 * than no gate. Run it deliberately from somewhere the RPC is reachable.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * NO EMBEDDED PRODUCTION DATA — THE #376 FENCE
 * ════════════════════════════════════════════════════════════════════════════════
 * PR #376 put a proof lifted from a production table — a real agent id, a real score —
 * into this PUBLIC repo, and it cannot be withdrawn. So this script hardcodes no tx
 * hash and no address: every identifier comes from the command line and stays in the
 * operator's shell.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * USAGE
 * ════════════════════════════════════════════════════════════════════════════════
 *   npx ts-node scripts/trust-loop/live-settlement-crosscheck.ts \
 *     --tx 0x<64 hex> --payee 0x<address> --value <whole USDC> [--confirmations N]
 *
 * Optional: --token 0x<address> overrides the configured USDC address, which is how
 * you test hypothesis (1) above without editing config.
 *
 * EXIT CODES, matching this repo's vocabulary:
 *   0  VERIFIED     — the chain confirms a payment of at least the claimed value
 *   2  NOT_CHECKED  — we could not look (no RPC, no config, wrong chain)
 *   1  FAILED       — we looked, and the settlement does not support the claim
 *
 * A FAILED result is not automatically a bug in the verifier. It is equally likely to
 * be a genuinely bad claim, which is the point. Read the reason before concluding.
 */
import { config } from '../../src/config';
import { verifySettlement } from '../../src/services/x402-settlement-verifier';

interface Args {
  tx?: string;
  payee?: string;
  value?: string;
  confirmations?: string;
  token?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a || !a.startsWith('--')) continue;
    const key = a.slice(2) as keyof Args;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function fail(message: string): never {
  console.error(`NOT_CHECKED — ${message}`);
  process.exit(2);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.tx) fail('--tx is required (the settlement transaction hash)');
  if (!args.payee) fail('--payee is required (the address that should have RECEIVED the payment)');
  if (!args.value) fail('--value is required (the claimed service value, in whole USDC)');

  const claimedValueUsdc = Number(args.value);
  if (!Number.isFinite(claimedValueUsdc) || claimedValueUsdc <= 0) {
    fail(`--value must be a positive number, got '${args.value}'`);
  }

  const token = args.token ?? config.usdcTokenAddress;
  if (!token) fail('no token address: pass --token or configure the USDC address');
  if (!config.baseSepoliaRpc) fail('no RPC endpoint configured');

  // Deliberately not printed: the RPC URL may carry an API key in its path.
  console.log('live settlement crosscheck');
  console.log(`  tx            ${args.tx}`);
  console.log(`  payee         ${args.payee}`);
  console.log(`  claimed value ${claimedValueUsdc} USDC`);
  console.log(`  token         ${token}`);
  console.log('');

  const result = await verifySettlement({
    txHash: args.tx!,
    payeeAddress: args.payee!,
    claimedValueUsdc,
    tokenAddress: token,
    ...(args.confirmations ? { minConfirmations: Number(args.confirmations) } : {}),
  });

  console.log(`  evidence      ${result.evidence}`);
  console.log(`  verified      ${result.verified}`);
  console.log(`  reason        ${result.reason}`);
  if (result.observedAmount !== undefined) {
    console.log(`  observed      ${result.observedAmount.toString()} (smallest unit)`);
  }
  if (result.confirmations !== undefined) console.log(`  confirmations ${result.confirmations}`);
  console.log('');

  // The three-state mapping is the whole point of the exit codes. An RPC that
  // could not be reached must NEVER exit 1: that would record "the settlement is
  // bad" when the truth is "nobody looked".
  if (result.evidence === 'NOT_CHECKED') {
    console.log('NOT_CHECKED — the chain was not consulted. This says nothing about the settlement.');
    process.exit(2);
  }
  if (result.verified) {
    console.log('VERIFIED — the live path resolves a real settlement end to end.');
    process.exit(0);
  }
  console.log('FAILED — the chain was consulted and does not support this claim.');
  console.log('        Before suspecting the verifier, check that the claim itself is true:');
  console.log('        a bad claim failing here is the mechanism working.');
  process.exit(1);
}

main().catch((e) => {
  // An unexpected throw is not a verdict about the settlement.
  console.error(`NOT_CHECKED — crosscheck threw: ${e?.message ?? e}`);
  process.exit(2);
});
