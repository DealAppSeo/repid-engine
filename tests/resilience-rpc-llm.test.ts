/**
 * resilience-rpc-llm.test.ts — B2 (RPC rotation) + B3 (LLM ordered chain → Ollama floor).
 *
 * Mocks ethers JsonRpcProvider (so getBlockNumber / rpcCall hit fakes, no network) and global fetch
 * (for the LLM chain + Ollama). Asserts the degrade path (primary throws → next endpoint serves) and
 * the all-down clear-error path (single AllRpcEndpointsDown / AllLlmProvidersDown, no hang).
 */

// ---- ethers mock: FallbackProvider + JsonRpcProvider with controllable per-URL behavior ----------
const rpcBehavior: Record<string, { fail?: boolean; block?: number }> = {};
jest.mock('ethers', () => {
  const actual = jest.requireActual('ethers');
  class MockJsonRpcProvider {
    url: string;
    constructor(url: string) {
      this.url = url;
    }
    async getBlockNumber() {
      const b = rpcBehavior[this.url];
      if (b?.fail) throw new Error(`rpc ${this.url} down`);
      return b?.block ?? 100;
    }
    async _call() {
      const b = rpcBehavior[this.url];
      if (b?.fail) throw new Error(`rpc ${this.url} down`);
      return '0xresult';
    }
  }
  return {
    ...actual,
    ethers: {
      ...actual.ethers,
      JsonRpcProvider: MockJsonRpcProvider,
      FallbackProvider: class {
        constructor(_p: any) {}
      },
    },
  };
});

import {
  rpcCall,
  rpcHealthPing,
  rpcHealth,
  AllRpcEndpointsDown,
  __resetRpcEndpoints,
} from '../src/clients/rpc-with-failover';
import { resilientComplete, AllLlmProvidersDown, llmHealth } from '../src/providers/resilient-llm';
import { __resetHealthBus } from '../src/resilience/health-bus';
import { recoverProviders } from '../src/providers/health';

process.env.NETWORK = 'base-sepolia';
process.env.RPC_ROTATION_ENABLED = 'true';

const URLS = [
  'https://sepolia.base.org',
  'https://base-sepolia-rpc.publicnode.com',
  'https://base-sepolia.gateway.tenderly.co',
];

beforeEach(() => {
  for (const u of URLS) rpcBehavior[u] = { fail: false, block: 100 };
  __resetRpcEndpoints();
  __resetHealthBus();
});

// ==================================================================================================
// B2 — RPC rotation
// ==================================================================================================
describe('B2 RPC wrapper', () => {
  it('rotates to the next endpoint when the primary throws', async () => {
    rpcBehavior[URLS[0]!] = { fail: true };
    const out = await rpcCall((p: any) => p._call());
    expect(out).toBe('0xresult');
  });

  it('throws a single AllRpcEndpointsDown when every endpoint fails (no hang)', async () => {
    for (const u of URLS) rpcBehavior[u] = { fail: true };
    await expect(rpcCall((p: any) => p._call())).rejects.toBeInstanceOf(AllRpcEndpointsDown);
  });

  it('rpcHealthPing reports ≥3 endpoints and marks a stale-block endpoint failing', async () => {
    rpcBehavior[URLS[2]!] = { fail: false, block: 10 }; // lags freshest (100) by >30
    const health = await rpcHealthPing();
    expect(health.length).toBeGreaterThanOrEqual(3);
    const stale = health.find((h) => h.endpoint === URLS[2]);
    expect(stale!.healthy).toBe(false);
  });

  it('rpcHealth returns one entry per configured URL', () => {
    const h = rpcHealth();
    expect(h.length).toBeGreaterThanOrEqual(3);
    expect(h.every((x) => x.surface === 'rpc')).toBe(true);
  });
});

// ==================================================================================================
// B3 — LLM ordered chain → Ollama floor
// ==================================================================================================
describe('B3 LLM wrapper', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.LLM_OLLAMA_FLOOR_ENABLED;
    recoverProviders();
  });

  function mockFetch(handler: (url: string) => { status: number; body?: any; headers?: Record<string, string> }) {
    global.fetch = jest.fn(async (url: any) => {
      const u = String(url);
      const r = handler(u);
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        headers: { get: (k: string) => r.headers?.[k] ?? null },
        json: async () => r.body ?? {},
      } as any;
    }) as any;
  }

  beforeEach(() => {
    process.env.GROQ_API_KEY = 'gk';
    process.env.CEREBRAS_API_KEY = 'ck';
    process.env.FIREWORKS_API_KEY = 'fk';
  });

  it('returns from the first healthy provider', async () => {
    mockFetch((u) => {
      if (u.includes('groq')) return { status: 200, body: { choices: [{ message: { content: 'hi from groq' } }], usage: {} } };
      return { status: 500 };
    });
    const out = await resilientComplete({ prompt: 'q' });
    expect(out.answer).toBe('hi from groq');
    expect(out.provider).toBe('groq');
  });

  it('falls through cloud providers down to the Ollama floor when enabled', async () => {
    process.env.LLM_OLLAMA_FLOOR_ENABLED = 'true';
    mockFetch((u) => {
      if (u.includes('11434/api/tags')) return { status: 200, body: [] };
      if (u.includes('11434/v1/chat')) return { status: 200, body: { choices: [{ message: { content: 'local floor' } }], usage: {} } };
      return { status: 503 }; // all cloud providers down
    });
    const out = await resilientComplete({ prompt: 'q' });
    expect(out.answer).toBe('local floor');
    expect(out.provider).toBe('ollama');
  });

  it('throws AllLlmProvidersDown when cloud + floor all unavailable (no hang)', async () => {
    // floor disabled, all cloud down
    mockFetch(() => ({ status: 503 }));
    await expect(resilientComplete({ prompt: 'q' })).rejects.toBeInstanceOf(AllLlmProvidersDown);
  });

  it('llmHealth lists the free chain providers', () => {
    // 2026-07-07: fireworks RETIRED (account suspended 2026-06-04); sambanova is the 3rd free family.
    const h = llmHealth();
    expect(h.map((x) => x.endpoint)).toEqual(expect.arrayContaining(['groq', 'cerebras', 'sambanova']));
  });
});
