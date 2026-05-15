const { ethers } = require('ethers');

const keys = [
  process.env.DEPLOYER_PRIVATE_KEY,
  process.env.APM_PRIVATE_KEY,
  process.env.VERITAS_PRIVATE_KEY,
  process.env.NEXUS_PRIVATE_KEY,
  process.env.BASE_SEPOLIA_PRIVATE_KEY
];

for (const k of keys) {
  if (!k) continue;
  try {
    const wallet = new ethers.Wallet(k);
    console.log(`Key ${k.substring(0, 5)}... Address: ${wallet.address}`);
  } catch (e) {}
}
