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
  const SUPA_URL = 'https://qnnpjhlxljtqyigedwkb.supabase.co';
  const apikey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFubnBqaGx4bGp0cXlpZ2Vkd2tiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTE5Mzk1OTEsImV4cCI6MjA2NzUxNTU5MX0.6oG2DU_BD1uBnBrDoQFauvN1ZnkKo2ywkuwY-tPaQFw';
  
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
