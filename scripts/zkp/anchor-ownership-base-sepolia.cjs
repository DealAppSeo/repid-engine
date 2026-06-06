/**
 * Anchor a zkp-vault anonymous-ownership proof on Base Sepolia (testnet) and
 * verify it back. (P1.3 of SPRINT_CC_2_2026-06-05.)
 *
 * The anchor is a proof-of-existence: a self-transaction whose calldata is
 *   anchorHash = keccak256(abi.encode(context, nullifier, keccak256(proofBytes)))
 * so the (context, nullifier) double-action key and the proof digest are
 * permanently recorded on-chain. Verify = re-fetch the tx and confirm the
 * calldata matches and the receipt status is success.
 *
 * Usage:
 *   node scripts/zkp/anchor-ownership-base-sepolia.cjs \
 *        --proof proof.bin --context 9001 --nullifier 531345275
 *
 * Reads DEPLOYER_PRIVATE_KEY + BASE_SEPOLIA_RPC_URL from the environment, or
 * falls back to repid-engine/.env (override with REPID_ENV).
 */
const fs = require('fs');
const { ethers } = require('ethers');

function loadEnv() {
  let pk = process.env.DEPLOYER_PRIVATE_KEY;
  let rpc = process.env.BASE_SEPOLIA_RPC_URL;
  if (!pk || !rpc) {
    const envPath = process.env.REPID_ENV || 'C:/Users/Cash4/repos/repid-engine/.env';
    try {
      const env = fs.readFileSync(envPath, 'utf8');
      const get = (k) => (env.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1]
        ?.trim().replace(/^["']|["']$/g, '');
      pk = pk || get('DEPLOYER_PRIVATE_KEY');
      rpc = rpc || get('BASE_SEPOLIA_RPC_URL');
    } catch { /* ignore */ }
  }
  return { pk, rpc: rpc || 'https://sepolia.base.org' };
}

const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : def;
};

(async () => {
  const proofPath = arg('proof', 'proof.bin');
  const context = BigInt(arg('context', '0'));
  const nullifier = BigInt(arg('nullifier', '0'));
  const { pk, rpc } = loadEnv();
  if (!pk) throw new Error('DEPLOYER_PRIVATE_KEY not found (env or repid-engine/.env)');

  const proofBytes = fs.readFileSync(proofPath);
  const proofDigest = ethers.keccak256(proofBytes);
  const anchorHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint256', 'uint256', 'bytes32'],
      [context, nullifier, proofDigest]
    )
  );

  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(pk, provider);
  const net = await provider.getNetwork();
  if (net.chainId !== 84532n) throw new Error(`expected Base Sepolia (84532), got ${net.chainId}`);
  console.log(`chainId=${net.chainId} from=${wallet.address}`);
  console.log(`proofDigest=${proofDigest}`);
  console.log(`anchorHash =${anchorHash}`);

  const tx = await wallet.sendTransaction({ to: wallet.address, value: 0n, data: anchorHash });
  console.log(`tx=${tx.hash} (waiting for confirmation)`);
  const receipt = await tx.wait();
  console.log(`mined block=${receipt.blockNumber} status=${receipt.status}`);

  // VERIFY: re-fetch the on-chain tx and confirm the anchored calldata + success.
  const onchain = await provider.getTransaction(tx.hash);
  const ok = onchain.data.toLowerCase() === anchorHash.toLowerCase() && receipt.status === 1;
  console.log(`VERIFY: ${ok ? 'PASS' : 'FAIL'} (onchain.data===anchorHash && status==1)`);
  const basescan = `https://sepolia.basescan.org/tx/${tx.hash}`;
  console.log(`basescan: ${basescan}`);

  fs.writeFileSync(
    'anchor-receipt.json',
    JSON.stringify(
      { txHash: tx.hash, block: receipt.blockNumber, chainId: Number(net.chainId),
        from: wallet.address, context: context.toString(), nullifier: nullifier.toString(),
        proofDigest, anchorHash, basescan, verifiedAt: new Date().toISOString() },
      null, 2
    )
  );
  console.log('wrote anchor-receipt.json');
  if (!ok) process.exit(1);
})().catch((e) => {
  console.error('ANCHOR FAILED:', e.message || e);
  process.exit(1);
});
