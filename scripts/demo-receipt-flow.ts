import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
import { ethers } from "ethers";
import { createClient } from "@supabase/supabase-js";

// Load repid-engine env for Supabase etc
dotenv.config();

// Load contracts env for BASE_SEPOLIA_PRIVATE_KEY
const contractsEnv = dotenv.parse(fs.readFileSync(path.join(__dirname, "../../hyperdag-protocol/packages/contracts/.env")));
const customerPk = contractsEnv.BASE_SEPOLIA_PRIVATE_KEY;
if (!customerPk) throw new Error("Missing BASE_SEPOLIA_PRIVATE_KEY");

const sellerPk = process.env.SOPHIA_PRIVATE_KEY;
if (!sellerPk) throw new Error("Missing SOPHIA_PRIVATE_KEY");

process.env.BASE_SEPOLIA_RPC_URL = contractsEnv.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";

import { postReputationSignal } from "../src/services/erc8004-poster";
import { getReceiptById } from "../src/services/receipt-issuer";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error("Missing Supabase configuration");
}

const db = createClient(SUPABASE_URL, SUPABASE_KEY);

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL);
  
  const sellerWallet = new ethers.Wallet(sellerPk!, provider);
  const customerWallet = new ethers.Wallet(customerPk!, provider);
  
  console.log("Seller (SOPHIA) Wallet address:", sellerWallet.address);
  console.log("Customer (Trinity Deployer) Wallet address:", customerWallet.address);

  // Deployments JSON
  const deploymentsPath = path.join(__dirname, "../../hyperdag-protocol/packages/contracts/deployments/base-sepolia.json");
  const deployments = JSON.parse(fs.readFileSync(deploymentsPath, "utf-8"));
  const adapterAddress = process.env.HYPERDAG_RECEIPT_ADAPTER_ADDRESS || deployments.hyperDAGReceiptAdapterProxy;
  
  if (!adapterAddress) throw new Error("Missing HYPERDAG_RECEIPT_ADAPTER_ADDRESS");

  const agentId = 3749; // SOPHIA token ID

  const syntheticX402 = {
    network: "base-sepolia",
    currency: "ETH",
    amount: "0.0001",
    resourceUri: "repid:service://sophia/demo",
    paymentHash: ethers.hexlify(ethers.randomBytes(32)) // Just a dummy hash for MVP
  };

  console.log("1. Forcing SOPHIA local task execution...");
  const cp = require('child_process');
  
  try {
    cp.execSync('node run-sophia-force.js', { 
      cwd: path.join(__dirname, "../../trinity-symphony-shared"),
      stdio: 'inherit'
    });
  } catch (err: any) {
    throw new Error(`SOPHIA execution failed: ${err.message}`);
  }

  console.log("Local execution finished. Finding the generated receipt in DB...");

  // Since we don't easily know the exact receiptId, we can just grab the most recent one for agentId 3749.
  const { data: receipts } = await db.from("hyperdag_receipts")
    .select("*")
    .eq("agent_id", 3749)
    .order("created_at", { ascending: false })
    .limit(1);

  if (!receipts || receipts.length === 0) {
    throw new Error("No receipt found for agent 3749.");
  }

  const receiptId = receipts[0].receipt_id;
  console.log(`Found generated Receipt ID: ${receiptId}`);

  console.log("2. Fetching receipt from DB...");
  let receiptJson = null;
  for (let i = 0; i < 5; i++) {
    receiptJson = await getReceiptById(receiptId);
    if (receiptJson) break;
    await sleep(2000);
  }

  if (!receiptJson) {
    throw new Error(`Receipt ${receiptId} not found in DB`);
  }

  // Save receipt artifact locally
  fs.writeFileSync("receipt_artifact.json", JSON.stringify(receiptJson, null, 2));
  console.log("Saved receipt_artifact.json");

  console.log("3. Orchestrating on-chain commit/reveal...");
  const artifact = JSON.parse(fs.readFileSync(path.join(__dirname, "../../hyperdag-protocol/packages/contracts/artifacts/contracts/receipt-bridge/HyperDAGReceiptAdapter.sol/HyperDAGReceiptAdapter.json"), "utf8"));
  const adapter = new ethers.Contract(adapterAddress, artifact.abi, sellerWallet);

  const rJson = receiptJson as any;
  const x402Hash = rJson.payment.paymentHash;
  const taskHash = rJson.work.taskHash;
  const resultHash = rJson.work.resultHash;
  const repIdComm = rJson.identity.repIdCommitment;
  const dofVersion = rJson.hal.dofVersion;
  const outputHash = rJson.hal.outputHash;
  const boundedScore = rJson.hal.boundedScore;
  const intBoundedScore = Math.round(boundedScore * 10000); 

  const hal = {
    dofVersion: dofVersion,
    outputHash: outputHash,
    boundedScore: intBoundedScore,
    commaBftVerdict: rJson.hal.commaBftVerdict === "pass" ? 0 : 1,
    dimensionsHash: rJson.hal.dimensionsHash
  };
  const humanIdentityRoot = ethers.ZeroHash;
  const receiptUriHash = ethers.keccak256(ethers.toUtf8Bytes(rJson.receiptId)); // Assume URI hash is just hash(receiptId) for now, or fetch from DB
  const receiptContentHash = rJson.receiptId;
  const scoreVersion = rJson.reputation.scoreVersion;
  const nonce = Math.floor(Math.random() * 1e9);

  const params = {
    agentId,
    x402PaymentHash: x402Hash,
    taskHash,
    resultHash,
    repIdCommitment: repIdComm,
    hal,
    humanIdentityRoot,
    receiptUriHash,
    receiptContentHash,
    scoreVersion,
    nonce,
    signature: "0x",
    proof: "0x01"
  };

  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const encoded = abiCoder.encode(
    ["string", "uint256", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "uint256"],
    ["HyperDAGReceipt.v1", agentId, x402Hash, taskHash, resultHash, repIdComm, outputHash, receiptContentHash, nonce]
  );
  const digest = ethers.keccak256(encoded);
  const signature = await sellerWallet.signMessage(ethers.getBytes(digest));
  params.signature = signature;

  const commitEncoded = abiCoder.encode(
    ["address", "uint256", "bytes32", "bytes32", "bytes32", "bytes32", "uint8", "bytes32", "int128", "uint8", "bytes32", "bytes32", "bytes32", "bytes32", "uint256", "uint256"],
    [sellerWallet.address, agentId, x402Hash, taskHash, resultHash, repIdComm, hal.dofVersion, hal.outputHash, hal.boundedScore, hal.commaBftVerdict, hal.dimensionsHash, humanIdentityRoot, receiptUriHash, receiptContentHash, scoreVersion, nonce]
  );
  const commitHash = ethers.keccak256(commitEncoded);

  console.log("Committing receipt to HyperDAGReceiptAdapter...");
  const commitTx = await (adapter as any).commitReceipt(commitHash);
  await commitTx.wait();
  console.log("Commit Tx Hash:", commitTx.hash);

  console.log("Waiting 6 blocks for commit reveal delay (Base Sepolia ~12s)...");
  for (let i = 0; i < 6; i++) {
    await sleep(2000);
    console.log(`Waited ${i+1}/6 blocks...`);
  }

  console.log("Revealing receipt...");
  const revealTx = await (adapter as any).revealReceipt(params);
  const revealReceiptTx = await revealTx.wait();
  console.log("ReceiptRevealed Tx Hash:", revealReceiptTx.hash);

  console.log("4. Posting ERC-8004 feedback...");
  process.env.ERC8004_OPERATOR_KEY = customerPk;
  const postOut = await postReputationSignal({
    agentId,
    receiptId: receiptContentHash,
    receiptUri: `repid:receipt://${receiptContentHash}`,
    receiptContentHash: receiptContentHash,
    score: hal.boundedScore / 10000,
    scoreDecimals: 4,
    tags: ["hyperdag.receipt.v1", "synthetic.e2e"]
  });

  console.log("giveFeedback Tx Hash:", postOut.txHash);
  console.log("✅ E2E DEMO SCRIPT COMPLETE!");
  process.exit(0);
}

main().catch(err => {
  console.error("Demo failed:", err);
  process.exit(1);
});
