import { ethers } from 'ethers';
import type { SupabaseClient } from '@supabase/supabase-js';
import { indexOnce, checkBftAggregation, type IndexOnceResult } from './receipt-indexer';

export interface IndexerServiceConfig {
  rpcUrl: string;
  contractAddress: string;
  chainId: number;
  supabase: SupabaseClient;
  pollIntervalMs?: number;
  blockWindow?: number;
  tipLagBlocks?: number;
  bftPollIntervalMs?: number;
  startBlockFallback?: number;
  stallThresholdMs?: number;
}

export const DEFAULT_STALL_THRESHOLD_MS = 10 * 60 * 1000;

export interface IndexerServiceStatus {
  status: 'starting' | 'running' | 'stopped' | 'error';
  startedAt: string | null;
  lastTickAt: string | null;
  lastBlock: number | null;
  lagBlocks: number | null;
  eventsProcessedTotal: number;
  ticksTotal: number;
  bftTicksTotal: number;
  lastError: { message: string; at: string } | null;
  cursorKey: string;
}

export interface IndexerService {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): IndexerServiceStatus;
  runBackfill(fromBlock: number, toBlock: number): Promise<IndexOnceResult>;
}

const MAX_RPC_ATTEMPTS = 5;

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RPC_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const delay = Math.min(8000, 500 * 2 ** (attempt - 1));
      console.warn(`[Indexer] ${label} attempt ${attempt}/${MAX_RPC_ATTEMPTS} failed; retrying in ${delay}ms:`, err instanceof Error ? err.message : err);
      if (attempt < MAX_RPC_ATTEMPTS) {
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

export function createIndexerService(config: IndexerServiceConfig): IndexerService {
  const pollIntervalMs = config.pollIntervalMs ?? 10000;
  const blockWindow = config.blockWindow ?? 100;
  const tipLagBlocks = config.tipLagBlocks ?? 1;
  const bftPollIntervalMs = config.bftPollIntervalMs ?? 5000;
  const stallThresholdMs = config.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;

  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const cursorKey = `receipt_indexer_cursor:chain-${config.chainId}:${config.contractAddress.toLowerCase()}`;

  const state: IndexerServiceStatus = {
    status: 'stopped',
    startedAt: null,
    lastTickAt: null,
    lastBlock: null,
    lagBlocks: null,
    eventsProcessedTotal: 0,
    ticksTotal: 0,
    bftTicksTotal: 0,
    lastError: null,
    cursorKey
  };

  let mainTimer: NodeJS.Timeout | null = null;
  let bftTimer: NodeJS.Timeout | null = null;
  let mainTickInFlight = false;
  let bftTickInFlight = false;

  let lastAdvanceAt = Date.now();
  let stallNotified = false;

  async function emitStallHitl(lastBlockSeen: number | null, elapsedMs: number): Promise<void> {
    try {
      const { error } = await config.supabase.from('trinity_hitl_requests').insert({
        agent_id: 'service:receipt-indexer',
        reason: 'indexer_stalled',
        status: 'pending',
        context: {
          cursorKey,
          contractAddress: config.contractAddress,
          chainId: config.chainId,
          lastBlock: lastBlockSeen,
          stallThresholdMs,
          elapsedMs,
          detectedAt: new Date().toISOString()
        }
      });
      if (error) {
        console.error('[Indexer] failed to write stall HITL request:', error.message);
        return;
      }
      console.warn(`[Indexer] STALL detected — cursor unchanged for ${elapsedMs}ms; HITL request raised`);
    } catch (err) {
      console.error('[Indexer] stall HITL emit threw:', err instanceof Error ? err.message : err);
    }
  }

  async function readCursor(): Promise<number | null> {
    const { data, error } = await config.supabase
      .from('trinity_kv_store')
      .select('value')
      .eq('key', cursorKey)
      .maybeSingle();
    if (error) {
      console.warn('[Indexer] Cursor read failed; treating as cold start:', error.message);
      return null;
    }
    if (!data) return null;
    const v = (data as { value: { lastBlock?: number } }).value;
    return typeof v?.lastBlock === 'number' ? v.lastBlock : null;
  }

  async function writeCursor(lastBlock: number): Promise<void> {
    const { error } = await config.supabase
      .from('trinity_kv_store')
      .upsert({
        key: cursorKey,
        value: {
          lastBlock,
          lastIndexedAt: new Date().toISOString(),
          contractAddress: config.contractAddress,
          chainId: config.chainId
        },
        tier: 'indexer-state',
        updated_at: new Date().toISOString()
      }, { onConflict: 'key' });
    if (error) {
      throw new Error(`cursor write failed: ${error.message}`);
    }
  }

  async function determineFromBlock(): Promise<number> {
    const cursor = await readCursor();
    if (cursor !== null) return cursor + 1;
    if (typeof config.startBlockFallback === 'number') return config.startBlockFallback;
    const tip = await provider.getBlockNumber();
    return Math.max(0, tip - 1000);
  }

  async function tick(): Promise<void> {
    if (mainTickInFlight) return;
    mainTickInFlight = true;
    const prevLastBlock = state.lastBlock;
    try {
      const tip: number = await withRetry<number>('eth_blockNumber', () => provider.getBlockNumber());
      const safeTip = Math.max(0, tip - tipLagBlocks);
      const fromBlock = await determineFromBlock();

      if (fromBlock > safeTip) {
        state.lastTickAt = new Date().toISOString();
        state.lastBlock = fromBlock - 1;
        state.lagBlocks = tip - (fromBlock - 1);
        state.ticksTotal += 1;
        return;
      }

      const toBlock = Math.min(fromBlock + blockWindow - 1, safeTip);

      const result = await withRetry(`indexOnce[${fromBlock}..${toBlock}]`, () =>
        indexOnce(fromBlock, toBlock, {
          provider,
          contractAddress: config.contractAddress,
          supabase: config.supabase
        })
      );

      await writeCursor(toBlock);

      state.lastTickAt = new Date().toISOString();
      state.lastBlock = toBlock;
      state.lagBlocks = tip - toBlock;
      state.eventsProcessedTotal += result.eventsProcessed;
      state.ticksTotal += 1;

      if (result.eventsProcessed > 0) {
        console.log(`[Indexer] tick @block ${toBlock}, +${result.eventsProcessed} events (revealed=${result.perEvent.revealed}, invalidated=${result.perEvent.invalidated}, committed=${result.perEvent.committed})`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state.lastError = { message, at: new Date().toISOString() };
      console.error('[Indexer] tick failed (cursor un-advanced; will retry next interval):', message);
    } finally {
      mainTickInFlight = false;
      const now = Date.now();
      if (state.lastBlock !== null && state.lastBlock !== prevLastBlock) {
        lastAdvanceAt = now;
        stallNotified = false;
      } else if (!stallNotified && now - lastAdvanceAt > stallThresholdMs) {
        stallNotified = true;
        await emitStallHitl(state.lastBlock, now - lastAdvanceAt);
      }
    }
  }

  async function bftTick(): Promise<void> {
    if (bftTickInFlight) return;
    bftTickInFlight = true;
    try {
      await checkBftAggregation(config.supabase);
      state.bftTicksTotal += 1;
    } catch (err) {
      console.error('[Indexer] BFT tick failed:', err instanceof Error ? err.message : err);
    } finally {
      bftTickInFlight = false;
    }
  }

  return {
    async start() {
      if (state.status === 'running') return;
      state.status = 'starting';
      state.startedAt = new Date().toISOString();
      console.log(`[Indexer] starting service for ${config.contractAddress} on chain ${config.chainId} (poll=${pollIntervalMs}ms, window=${blockWindow}, tipLag=${tipLagBlocks})`);
      await tick();
      mainTimer = setInterval(() => { void tick(); }, pollIntervalMs);
      bftTimer = setInterval(() => { void bftTick(); }, bftPollIntervalMs);
      state.status = 'running';
    },

    async stop() {
      if (mainTimer) { clearInterval(mainTimer); mainTimer = null; }
      if (bftTimer) { clearInterval(bftTimer); bftTimer = null; }
      state.status = 'stopped';
    },

    getStatus() {
      return { ...state };
    },

    async runBackfill(fromBlock: number, toBlock: number) {
      if (!Number.isInteger(fromBlock) || !Number.isInteger(toBlock) || toBlock < fromBlock) {
        throw new Error(`Invalid backfill range [${fromBlock}, ${toBlock}]`);
      }
      const result = await indexOnce(fromBlock, toBlock, {
        provider,
        contractAddress: config.contractAddress,
        supabase: config.supabase
      });
      state.eventsProcessedTotal += result.eventsProcessed;
      console.log(`[Indexer] backfill [${fromBlock}..${toBlock}] +${result.eventsProcessed} events`);
      return result;
    }
  };
}
