import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
import { ethers } from "ethers";

// Load repid-engine env for Supabase etc
dotenv.config();

// Load contracts env for BASE_SEPOLIA_PRIVATE_KEY
const contractsEnv = dotenv.parse(fs.readFileSync(path.join(__dirname, "../../hyperdag-protocol/packages/contracts/.env")));
const customerPk = contractsEnv.BASE_SEPOLIA_PRIVATE_KEY;
if (!customerPk) throw new Error("Missing BASE_SEPOLIA_PRIVATE_KEY");

const sellerPk = process.env.SOPHIA_PRIVATE_KEY;
if (!sellerPk) throw new Error("Missing SOPHIA_PRIVATE_KEY");

// Use seller (SOPHIA) as the operator for the poster temporarily to issue the receipt? Wait, the poster doesn't need the operator key.
// We'll set the ERC8004_OPERATOR_KEY right before postReputationSignal.
process.env.BASE_SEPOLIA_RPC_URL = contractsEnv.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";

import { issueReceipt } from "../src/services/receipt-issuer";
import { postReputationSignal } from "../src/services/erc8004-poster";
import { db } from "../src/db";

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

  const input = {
    agentId,
    agentWallet: sellerWallet.address,
    x402PaymentProof: {
      network: "base-sepolia",
      currency: "ETH",
      amount: "0.0001",
      resourceUri: "repid:service://sophia/validate"
    },
    taskInput: { service: "validate this market signal" },
    taskResult: { result: "True" },
    halOutput: {
      signals: {
        harm_probability: 0.0,
        epistemic_uncertainty: 0.0,
        evidence_quality: 1.0,
        scope_appropriateness: 1.0,
        certainty_at_claim: 1.0,
        agreement_score: 1.0
      },
      hal_score: 0.95,
      vetoed: false,
      veto_reason: null,
      veto_threshold: 0.5,
      comma_veto: false,
      comma_gap: null,
      comma_severity: "none" as any,
      formula: "repid-2026-04-17"
    },
    repIdCommitment: ethers.hexlify(ethers.randomBytes(32)) as `0x${string}`,
    scoreVersion: 5
  };

  console.log("Issuing synthetic receipt off-chain...");
  const receiptOut = await issueReceipt(input);
  console.log("Receipt JSON:", JSON.stringify(receiptOut.receiptJson, null, 2));

  // Verify in DB
  const { data: dbRow } = await db.from("hyperdag_receipts").select("*").eq("receipt_id", receiptOut.receiptJson.receiptId).single();
  if (dbRow) {
    console.log("Verified row in hyperdag_receipts!");
  } else {
    console.error("Failed to find row in hyperdag_receipts!");
  }

  // Load Adapter ABI
  const artifact = JSON.parse(fs.readFileSync(path.join(__dirname, "../../hyperdag-protocol/packages/contracts/artifacts/contracts/receipt-bridge/HyperDAGReceiptAdapter.sol/HyperDAGReceiptAdapter.json"), "utf8"));
  const adapter = new ethers.Contract(adapterAddress, artifact.abi, sellerWallet);

  // Re-calculate the hashes exactly as they are sent
  const rJson = receiptOut.receiptJson as any;
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
  const receiptUriHash = ethers.keccak256(ethers.toUtf8Bytes(receiptOut.receiptUri));
  const receiptContentHash = receiptOut.receiptHash;
  const scoreVersion = 5;
  const nonce = Math.floor(Math.random() * 1e9);

  // Build params
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
    proof: "0x"
  };

  // Construct digest
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const encoded = abiCoder.encode(
    ["string", "uint256", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "uint256"],
    [
      "HyperDAGReceipt.v1",
      agentId,
      x402Hash,
      taskHash,
      resultHash,
      repIdComm,
      outputHash,
      receiptContentHash,
      nonce
    ]
  );
  const digest = ethers.keccak256(encoded);
  const signature = await sellerWallet.signMessage(ethers.getBytes(digest));
  params.signature = signature;
  params.proof = "0x01"; // Stub verifier needs > 0 bytes

  // commit
  // commitHash is keccak256 of abi.encode(committer, params...)
  const commitEncoded = abiCoder.encode(
    [
      "address", "uint256", "bytes32", "bytes32", "bytes32", "bytes32", 
      "uint8", "bytes32", "int128", "uint8", "bytes32",
      "bytes32", "bytes32", "bytes32", "uint256", "uint256"
    ],
    [
      sellerWallet.address, agentId, x402Hash, taskHash, resultHash, repIdComm,
      hal.dofVersion, hal.outputHash, hal.boundedScore, hal.commaBftVerdict, hal.dimensionsHash,
      humanIdentityRoot, receiptUriHash, receiptContentHash, scoreVersion, nonce
    ]
  );
  const commitHash = ethers.keccak256(commitEncoded);

  console.log("Committing receipt to HyperDAGReceiptAdapter...");
  const commitTx = await (adapter as any).commitReceipt(commitHash);
  await commitTx.wait();
  console.log("Commit Tx Hash:", commitTx.hash);

  console.log("Waiting 5 blocks for commit reveal delay (Base Sepolia ~12s)...");
  // Wait 6 blocks to be safe
  for (let i = 0; i < 6; i++) {
    await new Promise(r => setTimeout(r, 2000));
    console.log(`Waited ${i+1}/6 blocks...`);
  }

  console.log("Revealing receipt...");
  const revealTx = await (adapter as any).revealReceipt(params);
  const revealReceiptTx = await revealTx.wait();
  console.log("ReceiptRevealed Tx Hash:", revealReceiptTx.hash);

  console.log("Posting ERC-8004 feedback...");
  
  // Use Customer's wallet to post feedback
  process.env.ERC8004_OPERATOR_KEY = customerPk;
  const postOut = await postReputationSignal({
    agentId,
    receiptId: receiptOut.receiptJson.receiptId as string,
    receiptUri: receiptOut.receiptUri,
    receiptContentHash: receiptContentHash,
    score: hal.boundedScore / 10000,
    scoreDecimals: 4,
    tags: ["hyperdag.receipt.v1", "synthetic.demo"]
  });

  console.log("giveFeedback Tx Hash:", postOut.txHash);
  console.log("✅ CLEAN DEMO SCRIPT COMPLETE!");
  process.exit(0);
}

main().catch(err => {
  console.error("Demo failed:", err);
  process.exit(1);
});
