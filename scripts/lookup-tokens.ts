import { ethers } from 'ethers';

const RPC = 'https://sepolia.base.org';
const REGISTRY_ADDRESS = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const TRINITY_DEPLOYER = '0xdf6b8215D193b11B4903d223729c3CF7A6de271d'.toLowerCase();

const abi = [
  "function ownerOf(uint256 tokenId) view returns (address)"
];

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const contract = new ethers.Contract(REGISTRY_ADDRESS, abi, provider);

  const tokens = [3747, 3748, 3749];
  for (const tokenId of tokens) {
    try {
      const owner = await contract.ownerOf(tokenId);
      const isDeployer = owner.toLowerCase() === TRINITY_DEPLOYER;
      console.log(`Token: ${tokenId} | Owner: ${owner} | Match Deployer: ${isDeployer}`);
    } catch (e: any) {
      console.log(`Token: ${tokenId} | Error: ${e.message}`);
    }
  }
}

main().catch(console.error);
