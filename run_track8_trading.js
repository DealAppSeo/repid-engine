const { ethers } = require("ethers");
const fs = require("fs");
const solc = require("solc");

async function run() {
  const provider = new ethers.JsonRpcProvider("https://sepolia.base.org");
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
  const wallet = new ethers.Wallet(privateKey, provider);
  
  const contractAddress = "0xd35331Bf94b1A4F4CAf595951056C288ce58C4fA";
  
  const source = fs.readFileSync("./contracts/RepIDStaking.sol", "utf8");
  const input = {
    language: 'Solidity',
    sources: { 'RepIDStaking.sol': { content: source } },
    settings: { outputSelection: { '*': { '*': ['*'] } } }
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const contractAbi = output.contracts['RepIDStaking.sol']['RepIDStaking'].abi;

  const stakingContract = new ethers.Contract(contractAddress, contractAbi, wallet);

  console.log("Staking 0.0001 ETH for SOPHIA...");
  let tx = await stakingContract.stake(1, 9988776655n, { value: ethers.parseEther("0.0001") });
  let receipt = await tx.wait();
  console.log("Stake Tx Hash:", tx.hash);

  // find stakeId mapping from event or just assume it's 1 since it's the first
  const stakeCount = await stakingContract.stakeCount();
  const stakeId = stakeCount; 
  console.log("Stake ID is:", stakeId.toString());

  console.log("HAL Approving stake (returning funds)...");
  tx = await stakingContract.approve(stakeId);
  receipt = await tx.wait();
  console.log("Approve Tx Hash:", tx.hash);

  console.log("Trading Scenario Complete.");
}
run();
