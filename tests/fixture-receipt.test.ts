/**
 * One fixture receipt. Exact string true returns written and id.
 * Unset writes nothing. The row stores no claim text.
 */
import { writeFixtureReceipt } from '../src/hal/fixture-receipt';

function mock(id: number) {
  const inserts: { table: string; row: Record<string, unknown> }[] = [];
  const client = {
    from(table: string) {
      return {
        insert(row: Record<string, unknown>) {
          inserts.push({ table, row });
          return {
            select(_columns: string) {
              return {
                async single() {
                  return { data: { id }, error: null };
                },
              };
            },
          };
        },
      };
    },
  };
  return { client, inserts };
}

describe('fixture receipt writer', () => {
  it('returns written true and the row id when the flag is the exact string true', async () => {
    const db = mock(42);
    const res = await writeFixtureReceipt(db.client, { HAL_QUORUM_RECEIPT_ENABLED: 'true' });
    expect(res).toEqual({ written: true, id: 42 });
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0]?.table).toBe('hal_quorum_receipts');
    expect(db.inserts[0]?.row).not.toHaveProperty('claim');
    expect(JSON.stringify(db.inserts[0]?.row)).not.toMatch(/claim/i);
  });

  it('returns written false and inserts nothing when the flag is unset', async () => {
    const db = mock(42);
    const unset = await writeFixtureReceipt(db.client, {});
    const folded = await writeFixtureReceipt(db.client, { HAL_QUORUM_RECEIPT_ENABLED: 'TRUE' });
    expect(unset).toEqual({ written: false });
    expect(folded).toEqual({ written: false });
    expect(db.inserts).toHaveLength(0);
  });
});
