/**
 * Honesty A counts verdicts. It does not invent them from latency.
 */

import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import {
  aggregateHonestyA,
  bucketVerdict,
  honestyANotChecked,
  HONESTY_A_LLM_LOG_GAP,
  readPassVerdict,
} from '../src/services/honesty-a';

const SRC = resolve(__dirname, '..', 'src');

describe('honesty A', () => {
  it('counts TRUE and FALSE and sends every other verdict to NOT_CHECKED', () => {
    const report = aggregateHonestyA([
      { family: 'llama', provider: 'groq', verdict: 'TRUE' },
      { family: 'llama', provider: 'groq', verdict: 'TRUE' },
      { family: 'llama', provider: 'groq', verdict: 'FALSE' },
      { family: 'llama', provider: 'groq', verdict: 'UNCERTAIN' },
      { family: 'llama', provider: 'groq', verdict: 'ERROR' },
      { family: 'qwen', provider: 'fireworks', verdict: 'FALSE' },
    ]);
    expect(report.status).toBe('counted');
    expect(report.rows).toEqual([
      {
        family: 'llama',
        host: 'groq',
        TRUE: 2,
        FALSE: 1,
        NOT_CHECKED: 2,
        first_pass: { TRUE: 0, FALSE: 0, NOT_CHECKED: 5 },
        post_hal: { TRUE: 0, FALSE: 0, NOT_CHECKED: 5 },
      },
      {
        family: 'qwen',
        host: 'fireworks',
        TRUE: 0,
        FALSE: 1,
        NOT_CHECKED: 0,
        first_pass: { TRUE: 0, FALSE: 0, NOT_CHECKED: 1 },
        post_hal: { TRUE: 0, FALSE: 0, NOT_CHECKED: 1 },
      },
    ]);
  });

  it('counts first_pass separately from post_hal', () => {
    const report = aggregateHonestyA([
      {
        family: 'llama',
        host: 'groq',
        verdict: 'TRUE',
        first_pass_verdict: 'TRUE',
        post_hal_verdict: 'FALSE',
      },
    ]);
    expect(report.rows).toEqual([
      {
        family: 'llama',
        host: 'groq',
        TRUE: 1,
        FALSE: 0,
        NOT_CHECKED: 0,
        first_pass: { TRUE: 1, FALSE: 0, NOT_CHECKED: 0 },
        post_hal: { TRUE: 0, FALSE: 1, NOT_CHECKED: 0 },
      },
    ]);
  });

  it('a missing first_pass is NOT_CHECKED, not 0', () => {
    const missing = readPassVerdict(undefined);
    expect(missing.status).toBe('NOT_CHECKED');
    expect(missing.verdict).toBeNull();
    expect(missing.verdict).not.toBe(0);

    const zero = readPassVerdict(0);
    expect(zero.status).toBe('NOT_CHECKED');
    expect(zero.verdict).toBeNull();
    expect(zero.verdict).not.toBe(0);

    const report = aggregateHonestyA([
      { family: 'llama', host: 'groq', post_hal_verdict: 'FALSE' },
    ]);
    expect(report.rows?.[0]?.first_pass).toEqual({ TRUE: 0, FALSE: 0, NOT_CHECKED: 1 });
    expect(report.rows?.[0]?.post_hal).toEqual({ TRUE: 0, FALSE: 1, NOT_CHECKED: 0 });
    expect(report.rows?.[0]?.first_pass.NOT_CHECKED).not.toBe(0);
  });

  it('a latency-only row is NOT_CHECKED and does not become TRUE', () => {
    const slow = aggregateHonestyA([
      { family: 'llama', provider: 'groq', latency_ms: 12 } as { family: string; provider: string },
    ]);
    const fast = aggregateHonestyA([
      { family: 'llama', provider: 'groq', latency_ms: 9000 } as { family: string; provider: string },
    ]);
    expect(slow.rows?.[0]?.TRUE).toBe(0);
    expect(slow.rows?.[0]?.NOT_CHECKED).toBe(1);
    expect(fast).toEqual(slow);
    expect(bucketVerdict(undefined)).toBe('NOT_CHECKED');
  });

  it('writer_enabled is false when the variable is unset, and only the exact string true sets it', () => {
    const saved = process.env.HAL_QUORUM_RECEIPT_ENABLED;
    try {
      delete process.env.HAL_QUORUM_RECEIPT_ENABLED;
      expect(aggregateHonestyA([]).writer_enabled).toBe(false);
      expect(honestyANotChecked(HONESTY_A_LLM_LOG_GAP).writer_enabled).toBe(false);
      expect(aggregateHonestyA([], {}).writer_enabled).toBe(false);
      expect(aggregateHonestyA([], { HAL_QUORUM_RECEIPT_ENABLED: 'TRUE' }).writer_enabled).toBe(false);
      expect(aggregateHonestyA([], { HAL_QUORUM_RECEIPT_ENABLED: 'on' }).writer_enabled).toBe(false);
      expect(aggregateHonestyA([], { HAL_QUORUM_RECEIPT_ENABLED: '1' }).writer_enabled).toBe(false);
      expect(aggregateHonestyA([], { HAL_QUORUM_RECEIPT_ENABLED: 'true' }).writer_enabled).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.HAL_QUORUM_RECEIPT_ENABLED;
      else process.env.HAL_QUORUM_RECEIPT_ENABLED = saved;
    }
  });

  it('a failed read is NOT_CHECKED with no rows, not a zero count', () => {
    const report = honestyANotChecked(HONESTY_A_LLM_LOG_GAP);
    expect(report.status).toBe('NOT_CHECKED');
    expect(report.rows).toBeNull();
    expect(report.gap).toContain('no verdict column');
  });

  it('the payload contract has no prompt and no user id, and the route does not read llm_call_log', () => {
    const report = aggregateHonestyA([
      { family: 'llama', provider: 'groq', verdict: 'TRUE' },
    ]);
    const text = JSON.stringify(report);
    expect(text).not.toContain('prompt');
    expect(text).not.toContain('user_id');
    expect(text).not.toContain('agent_id');

    const route = readFileSync(join(SRC, 'routes', 'honesty-a.ts'), 'utf8');
    expect(route).toContain(".from('hal_quorum_validator_votes')");
    expect(route).toContain(
      ".select('family, provider, host, verdict, first_pass_verdict, post_hal_verdict')",
    );
    expect(route).not.toContain("from('llm_call_log')");
    expect(route).not.toContain('user_id');
    expect(route).not.toContain('agent_id');
    expect(route).not.toContain('prompt');

    const logRow = readFileSync(join(SRC, 'types', 'database.types.ts'), 'utf8');
    const start = logRow.indexOf('llm_call_log:');
    const slice = logRow.slice(start, start + 700);
    expect(slice).not.toContain('verdict');
  });
});
