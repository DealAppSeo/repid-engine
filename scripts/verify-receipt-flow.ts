import * as fs from "fs";
import * as path from "path";
import { ethers } from "ethers";
import * as dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const contractsEnv = dotenv.parse(fs.readFileSync(path.join(__dirname, "../../hyperdag-protocol/packages/contracts/.env")));
process.env.BASE_SEPOLIA_RPC_URL = contractsEnv.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const db = createClient(SUPABASE_URL!, SUPABASE_KEY!);

const REVEAL_TX = "0x957658ad09954fd63bc386b822c2d08a540bf3c9787276bc8d2433014dbfc02e";
const FEEDBACK_TX = "0xf37dd5edbf022d1a167c3a0ad81c3149fb83676012bf288838bb6838cb05c927";
const RECEIPT_FILE = path.join(__dirname, "../receipt_artifact.json");

async function verify() {
  console.log("Starting Verification of 4 Artifacts...");

  // 1. Check Receipt JSON
  if (fs.existsSync(RECEIPT_FILE)) {
    const json = JSON.parse(fs.readFileSync(RECEIPT_FILE, "utf-8"));
    console.log("✅ 1. Receipt JSON exists. ID:", json.receiptId);
  } else {
    throw new Error("❌ 1. Receipt JSON missing");
  }

  const json = JSON.parse(fs.readFileSync(RECEIPT_FILE, "utf-8"));
  
  // 2. Check DB row
  const { data: row } = await db.from("hyperdag_receipts").select("*").eq("receipt_id", json.receiptId).single();
  if (row) {
    console.log("✅ 2. hyperdag_receipts row exists");
  } else {
    throw new Error("❌ 2. hyperdag_receipts row missing");
  }

  // 3 & 4. Check Transactions
  const provider = new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL);
  
  const revealReceipt = await provider.getTransactionReceipt(REVEAL_TX);
  if (revealReceipt && revealReceipt.status === 1) {
    console.log(`✅ 3. ReceiptRevealed transaction mined successfully: ${REVEAL_TX}`);
  } else {
    throw new Error("❌ 3. ReceiptRevealed transaction failed or not found");
  }

  const feedbackReceipt = await provider.getTransactionReceipt(FEEDBACK_TX);
  if (feedbackReceipt && feedbackReceipt.status === 1) {
    console.log(`✅ 4. giveFeedback transaction mined successfully: ${FEEDBACK_TX}`);
  } else {
    throw new Error("❌ 4. giveFeedback transaction failed or not found");
  }

  console.log("All 4 artifacts verified successfully!");
}

verify().catch(err => {
  console.error("Verification failed:", err);
  process.exit(1);
});
