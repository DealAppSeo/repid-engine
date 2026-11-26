/**
 * Reply and artifact are two copies of one answer (lesson of 2026-11-24). Cases are modelled on
 * rows read that day; the text here is written for the test, not copied from production.
 */
import { deliveryReport, readDelivery, type ReadDb } from '../src/orchestration/t12-delivery-check';
import { exitCodeFor } from '../scripts/t12/delivery-check';

const CONTRACT = { pattern: '^\\d+ \\| (SUPPORTED|NOT SUPPORTED)', min_lines: 4 };
const AUDIT = ['1 | SUPPORTED F1', '2 | SUPPORTED F9', '3 | SUPPORTED F9', '4 | NOT SUPPORTED'].join('\n');
const AUDIT_LINE_3_WRONG = AUDIT.replace('3 | SUPPORTED F9', '3 | NOT SUPPORTED');
const SUMMARY = 'Audit complete. The result was saved as a document artifact.';
const report = (reply: string | null, artifacts: Array<string | null>, contract: typeof CONTRACT | null = CONTRACT) =>
  deliveryReport({ taskId: 7, reply, artifacts: artifacts.map((content, i) => ({ id: 100 + i, content })), contract });

describe('delivery in reply and artifact', () => {
  it('finds the work in the artifact when the reply is only a summary', () => {
    const r = report(SUMMARY, [AUDIT]);
    expect([r.delivered_in_reply, r.delivered_in_artifact, r.disagree]).toEqual([false, true, null]);
    expect(r.reply.reason).toBe('matched 0 of 4 required lines');
    expect(r.verdict).toBe('DELIVERED in an artifact');
  });

  it('reports matching copies as agreeing, whatever their spacing', () => {
    const r = report(AUDIT, [AUDIT.replace(/SUPPORTED F/g, 'SUPPORTED   F').replace(/\n/g, '  \r\n')]);
    expect([r.delivered_in_reply, r.delivered_in_artifact, r.disagree]).toEqual([true, true, false]);
    expect(r.verdict).toBe('DELIVERED in the reply and an artifact; the copies match');
  });

  it('reports a reply and an artifact that both meet the contract and differ on a line', () => {
    const r = report(AUDIT_LINE_3_WRONG, [AUDIT]);
    expect([r.delivered_in_reply, r.delivered_in_artifact, r.disagree]).toEqual([true, true, true]);
    expect(r.differences).toEqual([{ line: 3, a: 'reply', a_text: '3 | NOT SUPPORTED', b: 'artifact 100', b_text: '3 | SUPPORTED F9' }]);
    expect(r.verdict).toBe('DISAGREE: 2 copies meet the contract and differ, first at line 3');
  });

  it('reads every artifact: a junk note beside the answer does not hide it, and two answers are compared', () => {
    expect(report(SUMMARY, ['Question for Architect:', AUDIT]).delivered_in_artifact).toBe(true);
    const two = report(SUMMARY, [AUDIT, AUDIT_LINE_3_WRONG]);
    expect(two.disagree).toBe(true);
    expect(two.differences[0]).toMatchObject({ line: 3, a: 'artifact 100', b: 'artifact 101' });
  });

  it('says not delivered only when every copy was judged and none meets the contract', () => {
    const r = report(SUMMARY, ['1 | SUPPORTED F1']);
    expect([r.delivered_in_reply, r.delivered_in_artifact, r.disagree]).toEqual([false, false, null]);
    expect(r.verdict).toBe('NOT_DELIVERED: neither the reply nor any artifact meets the contract');
    expect(report(SUMMARY, []).delivered_in_artifact).toBe(false);
    expect(report(null, [null]).artifacts[0]).toMatchObject({ state: 'empty', reason: 'the artifact has no content' });
  });

  it('does not judge a task with no contract', () => {
    const r = report(AUDIT, [AUDIT], null);
    expect([r.delivered_in_reply, r.delivered_in_artifact, r.disagree]).toEqual([null, null, null]);
    expect(r.verdict).toMatch(/^NOT_CHECKED: the task has no delivery contract/);
  });

  it('cuts off a pattern that backtracks without end and calls it not checked, not undelivered', () => {
    const started = Date.now();
    const r = report(`${'a'.repeat(40)}!`, [], { pattern: '^(a+)+$', min_lines: 1 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r.reply).toMatchObject({ state: 'not_checked', reason: 'contract_timeout' });
    expect(r.delivered_in_reply).toBeNull();
    expect(r.verdict).toMatch(/^NOT_CHECKED/);
  });

  it('gives a pass, a finding and a not-checked three different exit codes', () => {
    expect(exitCodeFor([report(AUDIT, [AUDIT])])).toBe(0);
    expect(exitCodeFor([report(AUDIT, [AUDIT]), report(AUDIT_LINE_3_WRONG, [AUDIT])])).toBe(3);
    expect(exitCodeFor([report(SUMMARY, [])])).toBe(3);
    expect(exitCodeFor([report(AUDIT, [AUDIT]), report(AUDIT, [AUDIT], null)])).toBe(2);
    expect(exitCodeFor([])).toBe(2);
  });
});

describe('reading one task', () => {
  const fakeDb = (task: Record<string, unknown> | null, artifacts: Array<{ id: number; content: string | null }>) => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const db: ReadDb = {
      query: async (sql, params = []) => {
        calls.push({ sql, params });
        if (sql.includes('FROM trinity_tasks')) return { rows: task ? [task] : [] };
        return { rows: artifacts };
      },
    };
    return { db, calls };
  };

  it('reads both tables with SELECT only, and the artifacts by the task id as text', async () => {
    const { db, calls } = fakeDb({ id: '439000', status: 'done', result: SUMMARY, metadata: { delivery_contract: CONTRACT } }, [{ id: 5, content: AUDIT }]);
    const r = await readDelivery(db, 439000);
    expect(calls.map((c) => c.sql.split(' ')[0])).toEqual(['SELECT', 'SELECT']);
    expect(calls[1]).toEqual({ sql: 'SELECT id, content FROM trinity_artifacts WHERE task_id = $1 ORDER BY id', params: ['439000'] });
    expect(r).toMatchObject({ task_id: '439000', status: 'done', contract_source: 'metadata.delivery_contract', delivered_in_reply: false, delivered_in_artifact: true });
  });

  it('takes the contract from the row, then the lane spec, and lets an argument override both', async () => {
    const lane = { t12: { spec: { context: ['lib/x.ts', `meta:delivery_contract.pattern=${CONTRACT.pattern}`, 'meta:delivery_contract.min_lines=4'] } } };
    expect((await readDelivery(fakeDb({ result: AUDIT, metadata: lane }, []).db, 1)).contract_source).toBe('spec context meta');
    expect((await readDelivery(fakeDb({ result: AUDIT, metadata: JSON.stringify({ delivery_contract: CONTRACT }) }, []).db, 1)).contract_source).toBe('metadata.delivery_contract');
    const over = await readDelivery(fakeDb({ result: AUDIT, metadata: { delivery_contract: CONTRACT } }, []).db, 1, { pattern: 'SUPPORTED', min_lines: 9 });
    expect(over).toMatchObject({ contract_source: 'argument', delivered_in_reply: false });
    expect((await readDelivery(fakeDb({ result: AUDIT, metadata: { delivery_contract: { pattern: '', min_lines: 2 } } }, []).db, 1)).contract).toBeNull();
  });

  it('stops on a task that is not there, or an id that is not a number', async () => {
    await expect(readDelivery(fakeDb(null, []).db, 5)).rejects.toThrow('task 5 was not found');
    await expect(readDelivery(fakeDb(null, []).db, '5; DROP TABLE x')).rejects.toThrow('task id must be a number');
  });
});
