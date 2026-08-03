const { ethers } = require("ethers");
const fs = require("fs");
const solc = require("solc");

async function run() {
  const source = fs.readFileSync("./contracts/RepIDStaking.sol", "utf8");
  const input = {
    language: 'Solidity',
    sources: { 'RepIDStaking.sol': { content: source } },
    settings: { outputSelection: { '*': { '*': ['*'] } } }
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const contract = output.contracts['RepIDStaking.sol']['RepIDStaking'];
  
  const abi = contract.abi;
  const bytecode = contract.evm.bytecode.object;

  console.log("Compiled successfully!");
  
  // Connect
  const provider = new ethers.JsonRpcProvider("https://sepolia.base.org");
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!privateKey) throw new Error("Missing DEPLOYER_PRIVATE_KEY");
  
  const wallet = new ethers.Wallet(privateKey, provider);
  console.log("Deployer:", wallet.address);

  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  console.log("Deploying...");
  const c = await factory.deploy("0x8004A818BFB912233c491871b3d84c89A494BD9e");
  await c.waitForDeployment();
  const address = await c.getAddress();
  const txHash = c.deploymentTransaction().hash;
  console.log("Contract Address:", address);
  console.log("Tx Hash:", txHash);

  // Update supabase
  const SUPA_URL = process.env.SUPABASE_URL;
  // Read from the environment. This was a hardcoded anon JWT for Trinity prod until
  // 2026-08-03 — a key in a script is a key in the repo, whatever its privilege level.
  const apikey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!SUPA_URL || !apikey) {
    throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY (or SUPABASE_SERVICE_KEY) must be set");
  }
  
  await fetch(`${SUPA_URL}/rest/v1/repid_config`, {
    method: "POST",
    headers: {
        'apikey': apikey,
        'Authorization': 'Bearer ' + apikey,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
    },
    body: JSON.stringify({
        key: 'staking_contract_address',
        value: address,
        description: 'RepIDStaking contract on Base Sepolia'
    })
  });
  console.log("Saved to Supabase.");
}
run();
