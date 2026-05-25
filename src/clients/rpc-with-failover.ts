import { ethers } from 'ethers';
import { getActiveNetwork } from '../config/network';

let cachedProvider: ethers.AbstractProvider | null = null;
let cachedNetworkName: string | null = null;

/**
 * Returns a configured ethers provider for the active network.
 * If multiple RPC URLs are defined in network config, returns a FallbackProvider.
 * Otherwise, returns a standard JsonRpcProvider.
 * Caches the provider instance to avoid excessive instantiations.
 *
 * @param forceNew - If true, bypasses the cache and creates a new provider.
 */
export function getProvider(forceNew = false): ethers.AbstractProvider {
  const netConfig = getActiveNetwork();
  
  if (!forceNew && cachedProvider && cachedNetworkName === netConfig.name) {
    return cachedProvider;
  }

  const urls = netConfig.rpcUrls && netConfig.rpcUrls.length > 0
    ? netConfig.rpcUrls
    : (netConfig.rpcUrl ? [netConfig.rpcUrl] : []);

  if (urls.length === 0) {
    throw new Error(`No RPC URLs configured for network: ${netConfig.name}`);
  }

  let provider: ethers.AbstractProvider;

  if (urls.length > 1) {
    // FallbackProvider expects an array of JsonRpcProvider instances (or configs) in ethers v6
    const providers = urls.map(url => new ethers.JsonRpcProvider(url, undefined, {
      staticNetwork: true // Optimizes by bypassing chainId verification call if chainId is static
    }));
    provider = new ethers.FallbackProvider(providers);
  } else {
    provider = new ethers.JsonRpcProvider(urls[0], undefined, {
      staticNetwork: true
    });
  }

  cachedProvider = provider;
  cachedNetworkName = netConfig.name;

  return provider;
}

/**
 * Resets the cached provider. Useful for testing when switching networks dynamically.
 */
export function resetProviderCache(): void {
  cachedProvider = null;
  cachedNetworkName = null;
}
