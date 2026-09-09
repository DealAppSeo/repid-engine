/**
 * NVIDIA NIM as a fact-check quorum member — the two properties that let it ship:
 *   1. DEFAULT OFF, and off means byte-identical: a bare NVIDIA_NIM_API_KEY does
 *      NOT add it (opt-in, never auto-backfilled), so the load-bearing quorum is
 *      unchanged until HAL_S2_ENABLE_NVIDIA_NIM=true is set deliberately.
 *   2. When on, it is the `nvidia` (Nemotron) family — a genuine additional vote,
 *      and a non-responding NIM degrades the quorum rather than biasing it (the
 *      aggregation excludes ERROR verdicts; see the fact-check resilience tests).
 *
 * Property 1 is the safety claim for shipping this un-measured (task requirement 2/3):
 * the quorum a reviewer measured yesterday is the quorum that runs today.
 */
import { buildFactCheckProviders } from '../src/hal/fact-check';
import { getHalConfig, invalidateHalConfigCache } from '../src/hal/config';

// getHalConfig reads repid_config; mock the db so it degrades to env/default (no network).
jest.mock('../src/db', () => ({
  db: { from() { throw new Error('db_unavailable_in_unit_test'); } },
}));

const NIM_ENVS = ['NVIDIA_NIM_API_KEY', 'NIM_API_KEY', 'HAL_S2_ENABLE_NVIDIA_NIM', 'HAL_S2_NVIDIA_NIM_MODEL'] as const;
// The rest of the quorum env that must be pinned so this test measures NIM, not the machine.
const OTHER_ENVS = [
  'GROQ_API_KEY', 'CEREBRAS_API_KEY', 'HAL_S2_CEREBRAS_MODEL', 'HAL_QUORUM_AUTOBACKFILL',
  'DEEPSEEK_API_KEY', 'GEMINI_API_KEY', 'MISTRAL_API_KEY', 'OPENROUTER_API_KEY', 'ZAI_API_KEY',
  'FIREWORKS_API_KEY', 'ANTHROPIC_API_KEY', 'GLOO_API_KEY', 'HAL_S2_ENABLE_FRONTIER_FREE',
] as const;

describe('NVIDIA NIM fact-check provider — default OFF, opt-in only', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of [...NIM_ENVS, ...OTHER_ENVS]) saved[k] = process.env[k];
    // Isolate: a lone always-on groq, autobackfill off, every other provider keyless.
    for (const k of [...NIM_ENVS, ...OTHER_ENVS]) delete process.env[k];
    process.env.HAL_QUORUM_AUTOBACKFILL = 'false';
    process.env.GROQ_API_KEY = 'g';
  });
  afterEach(() => {
    for (const k of [...NIM_ENVS, ...OTHER_ENVS]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
    invalidateHalConfigCache();
  });

  it('is ABSENT when the flag is unset — even with a key present (no auto-backfill)', () => {
    process.env.NVIDIA_NIM_API_KEY = 'nim-key';
    // flag unset
    const names = buildFactCheckProviders().map((p) => p.name);
    expect(names).not.toContain('nvidia-nim');
    // byte-identical to no-NIM-key at all:
    delete process.env.NVIDIA_NIM_API_KEY;
    expect(buildFactCheckProviders().map((p) => p.name)).toEqual(names);
  });

  it('is ABSENT when the flag is ON but no key is set (nothing to dial)', () => {
    process.env.HAL_S2_ENABLE_NVIDIA_NIM = 'true';
    expect(buildFactCheckProviders().map((p) => p.name)).not.toContain('nvidia-nim');
  });

  it('is PRESENT only when BOTH the flag and the key are set, as the `nvidia` family', () => {
    process.env.NVIDIA_NIM_API_KEY = 'nim-key';
    process.env.HAL_S2_ENABLE_NVIDIA_NIM = 'true';
    const nim = buildFactCheckProviders().find((p) => p.name === 'nvidia-nim');
    expect(nim).toBeDefined();
    expect(nim!.family).toBe('nvidia');
    expect(nim!.endpoint).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
    // openai dialect (undefined ⇒ openai) so it is redirected, not dropped, under LOCAL_LLM_BASE_URL.
    expect(nim!.dialect ?? 'openai').toBe('openai');
    expect(nim!.model).toBeTruthy(); // a model resolved (documentation-sourced default or override)
  });

  it('still accepts the legacy NIM_API_KEY when the canonical NVIDIA_NIM_API_KEY is unset', () => {
    // NOT the name in .env.master any more -- renamed to the canonical one 2026-09-09. This test
    // pins the compatibility shim for environments that still carry the old name; it is not
    // evidence about what any particular machine holds.
    process.env.NIM_API_KEY = 'legacy-nim-key';
    process.env.HAL_S2_ENABLE_NVIDIA_NIM = 'true';
    expect(buildFactCheckProviders().map((p) => p.name)).toContain('nvidia-nim');
  });

  it('honours HAL_S2_NVIDIA_NIM_MODEL as the model override', () => {
    process.env.NVIDIA_NIM_API_KEY = 'nim-key';
    process.env.HAL_S2_ENABLE_NVIDIA_NIM = 'true';
    process.env.HAL_S2_NVIDIA_NIM_MODEL = 'nvidia/nemotron-x-test';
    const nim = buildFactCheckProviders().find((p) => p.name === 'nvidia-nim');
    expect(nim!.model).toBe('nvidia/nemotron-x-test');
  });

  it('config: HAL_S2_ENABLE_NVIDIA_NIM resolves FALSE by default (env unset, db unavailable)', async () => {
    invalidateHalConfigCache();
    const cfg = await getHalConfig();
    expect(cfg.providers.HAL_S2_ENABLE_NVIDIA_NIM).toBe(false);
  });
});
