/**
 * The status digest — the thing the Controller app was supposed to be.
 *
 * This report goes to the person making decisions from it, which makes flattering
 * it worse than flattering a landing page. So the tests are almost entirely about
 * refusing to flatter:
 *
 *   · zero prints as zero, with a sentence saying nobody is out there
 *   · npm is labelled unmeasurable rather than quoted
 *   · "external" is declared a heuristic, not a fact
 *   · a delivered-but-unpaid contract is an alert, because a provider is owed
 */

import { looksExternal, renderDigest, type DigestData } from '../src/services/status-digest';

describe('who counts as external — the heuristic', () => {
  it('excludes everything we have ever named', () => {
    for (const n of [
      'trinity-orch',
      'trinity-mock-it-seller-1782341207177',
      'trinity-cc-a2a-provider-0730c',
      'smoke',
      'smoke_1778135188517',
      'test-agent-v11',
      'A7SmokeTest',
      'my_production_test_agent',
      'phase-n-external-1751939610',
      'ProdA7E2E',
    ]) {
      expect(looksExternal(n)).toBe(false);
    }
  });

  it('excludes the April demo personas that predate the naming convention', () => {
    // Five agents are literally called HUMAN. Counting those as external would
    // report the first "real user" as five people who do not exist.
    for (const n of ['HUMAN', 'SEAN', 'ATLAS', 'ORACLE', 'SAGE', 'MEDIATOR', 'demo-openai-agent']) {
      expect(looksExternal(n)).toBe(false);
    }
  });

  it('counts a plausibly real stranger', () => {
    for (const n of ['acme-research-bot', 'jdoe-agent', 'langchain-helper']) {
      expect(looksExternal(n)).toBe(true);
    }
  });

  it('is case-insensitive — naming shape must not be evadable by capitalisation', () => {
    expect(looksExternal('TRINITY-ORCH')).toBe(false);
    expect(looksExternal('Smoke_Test')).toBe(false);
  });

  it('treats empty/missing as not-external rather than counting a blank as a user', () => {
    expect(looksExternal(null)).toBe(false);
    expect(looksExternal('')).toBe(false);
    expect(looksExternal('   ')).toBe(false);
  });
});

function digest(over: Partial<DigestData> = {}): DigestData {
  return {
    generated_at: '2026-08-02T20:00:00.000Z',
    reach: {
      external_agents_all_time: 0,
      external_agents_7d: 0,
      self_serve_keys: 0,
      npm_note: 'npm downloads are NOT a usage signal — mirrors, CI and scanners are counted.',
    },
    loop: {
      settled_all_time: 7,
      settled_24h: 4,
      usdc_moved_24h: '$0.4000',
      real_settlements_all_time: 106,
      onchain_rep_writes: 78,
    },
    money: { llm_spend_24h: '$0.0800', llm_calls_24h: 5000, free_tier_pct: 63 },
    alerts: [],
    ...over,
  } as DigestData;
}

describe('the digest does not flatter', () => {
  it('prints zero as zero and says nobody is out there', () => {
    const out = renderDigest(digest());
    expect(out).toContain('external agents: <b>0</b>');
    expect(out).toContain('nobody outside the project has registered an agent yet');
  });

  it('labels npm unmeasurable instead of quoting a download count', () => {
    const out = renderDigest(digest());
    expect(out).toContain('NOT a usage signal');
    // The flattering number must not appear anywhere.
    expect(out).not.toMatch(/386|downloads:/);
  });

  it('declares "external" a heuristic rather than a fact', () => {
    expect(renderDigest(digest())).toMatch(/heuristic, not proof/);
  });

  it('does NOT headline the 104 active agents — ~92 of them are ours', () => {
    const out = renderDigest(digest());
    expect(out).not.toContain('104');
    expect(out).not.toMatch(/active agents/i);
  });
});

describe('status vs alert', () => {
  it('is green with no alerts and says so plainly', () => {
    const out = renderDigest(digest());
    expect(out.startsWith('🟢')).toBe(true);
    expect(out).toContain('NEEDS YOU');
    expect(out).toContain('nothing.');
  });

  it('turns amber and lists what needs a human', () => {
    const out = renderDigest(
      digest({ alerts: ['2 HITL item(s) waiting over 24h', '1 delivered+accepted contract(s) UNPAID — provider is owed'] }),
    );
    expect(out.startsWith('🟠')).toBe(true);
    expect(out).toContain('⚠ NEEDS YOU');
    expect(out).toContain('provider is owed');
  });

  it('always reports the loop and the cost, alerts or not', () => {
    for (const d of [digest(), digest({ alerts: ['x'] })]) {
      const out = renderDigest(d);
      expect(out).toContain('settled contracts');
      expect(out).toContain('real USDC moved');
      expect(out).toContain('LLM:');
    }
  });

  it('omits the free-tier share rather than printing a fake 0% when there were no calls', () => {
    const out = renderDigest(digest({ money: { llm_spend_24h: '$0.0000', llm_calls_24h: 0, free_tier_pct: null } }));
    expect(out).toContain('over 0 calls');
    expect(out).not.toContain('% free tier');
  });
});
