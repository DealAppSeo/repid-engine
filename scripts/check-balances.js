const { ethers } = require('ethers');
const provider = new ethers.JsonRpcProvider('https://sepolia.base.org');

const keys = [
  { name: 'DEPLOYER_PRIVATE_KEY', pk: process.env.DEPLOYER_PRIVATE_KEY },
  { name: 'TRINITY_DEPLOYER_PRIVATE_KEY', pk: process.env.TRINITY_DEPLOYER_PRIVATE_KEY },
  { name: 'BUYER_PRIVATE_KEY', pk: process.env.BUYER_PRIVATE_KEY }
];

async function main() {
  for (const k of keys) {
    if (!k.pk) continue;
    try {
      const wallet = new ethers.Wallet(k.pk, provider);
      console.log(`${k.name} Address: ${wallet.address}`);
      const eth = await provider.getBalance(wallet.address);
      console.log(` ETH Balance: ${ethers.formatEther(eth)}`);
      
      const usdcAddress = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
      const usdcAbi = ['function balanceOf(address) view returns (uint256)'];
      const usdc = new ethers.Contract(usdcAddress, usdcAbi, provider);
      const bal = await usdc.balanceOf(wallet.address);
      console.log(` USDC Balance: ${ethers.formatUnits(bal, 6)}`);
    } catch (e) {
      console.error(`${k.name} Error: ${e.message}`);
    }
  }
}
main();
