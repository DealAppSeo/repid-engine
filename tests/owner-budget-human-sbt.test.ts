/**
 * R2 (2026-11-16): a verified human gets the same owner budget a builder does.
 *
 * MEASURED: the first live owner-budget run stopped at bind. The owner's wallet holds a proof-of-human
 * SBT, so it bound as human_sbt, and ownerBuilderOfAgent returned null for every human_sbt owner, so
 * no budget existed (E:\dev\reports\2026-11-16\owner-budget-e2e-execute.attempt1-sbt-wallet.json).
 * The stake is keyed by builder account, and that run had just created one for the same wallet.
 *
 * Behind HUMAN_SBT_OWNER_BUDGET_ENABLED (default off). The binding is not changed, so the owner's
 * assurance label stays proof-of-human.
 */
const WALLET = '0x' + 'ab'.repeat(20);
let owner: any = null;
let builderRows: any[] = [];
let builderErr: any = null;
const ilikeCalls: unknown[][] = [];

jest.mock('../src/services/human-agent-binding', () => ({ ownerOfAgent: async () => owner }));
jest.mock('../src/db', () => ({
  db: {
    from(table: string) {
      if (table !== 'builders') throw new Error(`unexpected table ${table}`);
      const b: any = {
        select: () => b,
        ilike: (...args: unknown[]) => { ilikeCalls.push(args); return b; },
        limit: async () => ({ data: builderErr ? null : builderRows, error: builderErr }),
      };
      return b;
    },
  },
}));

import { ownerBuilderOfAgent } from '../src/services/owner-budget';

const SBT_OWNER = { owner_kind: 'human_sbt', human_token_id: 'SBT-AB-1', builder_id: null, human_wallet: WALLET };
const ON = true;

beforeEach(() => {
  owner = null;
  builderRows = [];
  builderErr = null;
  ilikeCalls.length = 0;
});

test('a builder owner resolves to its builder account, flag or not (unchanged)', async () => {
  owner = { owner_kind: 'builder', builder_id: 'b-1', human_wallet: WALLET };
  await expect(ownerBuilderOfAgent('a-1', false)).resolves.toBe('b-1');
  await expect(ownerBuilderOfAgent('a-1', ON)).resolves.toBe('b-1');
});

test('flag off: a human_sbt owner still has no budget (today, unchanged)', async () => {
  owner = SBT_OWNER;
  builderRows = [{ id: 'b-same-wallet' }];
  await expect(ownerBuilderOfAgent('a-1', false)).resolves.toBeNull();
  expect(ilikeCalls).toHaveLength(0);
});

test('flag on: a human_sbt owner gets the budget of the account that holds the same wallet', async () => {
  owner = SBT_OWNER;
  builderRows = [{ id: 'b-same-wallet' }];
  await expect(ownerBuilderOfAgent('a-1', ON)).resolves.toBe('b-same-wallet');
  // The wallet comes from the binding row (taken from human_sbt_registry at bind), never the caller.
  expect(ilikeCalls[0]).toEqual(['address', WALLET]);
});

test('flag on: no account for that wallet means no budget, not someone else\'s', async () => {
  owner = SBT_OWNER;
  builderRows = [];
  await expect(ownerBuilderOfAgent('a-1', ON)).resolves.toBeNull();
});

test('flag on: two accounts matching the wallet is refused, never a pick', async () => {
  owner = SBT_OWNER;
  builderRows = [{ id: 'b-1' }, { id: 'b-2' }];
  await expect(ownerBuilderOfAgent('a-1', ON)).rejects.toThrow(/ambiguous/);
});

test('flag on: a failed read is an error, not "no budget"', async () => {
  owner = SBT_OWNER;
  builderErr = { message: 'connection reset' };
  await expect(ownerBuilderOfAgent('a-1', ON)).rejects.toThrow(/connection reset/);
});

test('flag on: a binding with no wallet, or a malformed one, has no budget and runs no query', async () => {
  for (const w of [null, '', 'not-a-wallet', WALLET + '%', '0x' + 'g'.repeat(40)]) {
    owner = { ...SBT_OWNER, human_wallet: w };
    builderRows = [{ id: 'b-any' }];
    await expect(ownerBuilderOfAgent('a-1', ON)).resolves.toBeNull();
  }
  expect(ilikeCalls).toHaveLength(0);
});

test('the default reads HUMAN_SBT_OWNER_BUDGET_ENABLED, and only the exact string "true" turns it on', async () => {
  owner = SBT_OWNER;
  builderRows = [{ id: 'b-same-wallet' }];
  const saved = process.env.HUMAN_SBT_OWNER_BUDGET_ENABLED;
  try {
    for (const v of [undefined, '1', 'TRUE', 'yes', ' true']) {
      if (v === undefined) delete process.env.HUMAN_SBT_OWNER_BUDGET_ENABLED;
      else process.env.HUMAN_SBT_OWNER_BUDGET_ENABLED = v;
      await expect(ownerBuilderOfAgent('a-1')).resolves.toBeNull();
    }
    process.env.HUMAN_SBT_OWNER_BUDGET_ENABLED = 'true';
    await expect(ownerBuilderOfAgent('a-1')).resolves.toBe('b-same-wallet');
  } finally {
    if (saved === undefined) delete process.env.HUMAN_SBT_OWNER_BUDGET_ENABLED;
    else process.env.HUMAN_SBT_OWNER_BUDGET_ENABLED = saved;
  }
});
