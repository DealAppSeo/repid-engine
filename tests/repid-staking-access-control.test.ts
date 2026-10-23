/**
 * RepIDStaking.sol — PINS KNOWN DEFECTS. Read-only: compiles the source with solc and reads the AST.
 *
 * The source in contracts/RepIDStaking.sol is what runs at 0xd35331Bf94b1A4F4CAf595951056C288ce58C4fA
 * on Base Sepolia (chain 84532): the deployed dispatcher has exactly this file's eight selectors,
 * measured 2026-10-22 with eth_getCode. That contract held 0 ETH that day, so nothing is at risk,
 * but it must not be funded, and docs/staking/REPIDSTAKING_RISK_AND_DESIGN.md says why.
 *
 * What is pinned, each with the line it lives on:
 *   - `approve` and `slash` are external, carry no modifier, and never read msg.sender or
 *     tx.origin: ANY address can release or slash ANY pending stake.
 *   - Only `approve` moves ETH out. There is no withdraw, so slashed stakes and anything sent to
 *     `receive` are locked in the contract for good.
 *   - `identityRegistry` is stored and never read: nothing checks that the staker controls agentId.
 *
 * When a replacement adds access control, this file goes red. That is the point: DELETE it then and
 * write the negative tests the design doc names, rather than editing these assertions to pass.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const solc = require('solc');

const FILE = join(__dirname, '..', 'contracts', 'RepIDStaking.sol');
const source = readFileSync(FILE, 'utf8');
const lineOf = (node: { src: string }) => source.slice(0, Number(node.src.split(':')[0])).split('\n').length;

type Node = { nodeType: string; name?: string; kind?: string; src: string; [k: string]: any };
const walk = (n: unknown, visit: (x: Node) => void): void => {
  if (Array.isArray(n)) { n.forEach((x) => walk(x, visit)); return; }
  if (n && typeof n === 'object') {
    if (typeof (n as Node).nodeType === 'string') visit(n as Node);
    for (const v of Object.values(n)) walk(v, visit);
  }
};
const reads = (body: unknown, member: string, base: string) => {
  let hit = false;
  walk(body, (x) => { if (x.nodeType === 'MemberAccess' && x.memberName === member && x.expression?.name === base) hit = true; });
  return hit;
};

describe('RepIDStaking.sol known defects (pinned)', () => {
  let fns: Node[] = [];
  let contract: Node;

  beforeAll(() => {
    const out = JSON.parse(solc.compile(JSON.stringify({
      language: 'Solidity',
      sources: { 'RepIDStaking.sol': { content: source } },
      settings: { outputSelection: { '*': { '': ['ast'] } } },
    })));
    expect((out.errors ?? []).filter((e: { severity: string }) => e.severity === 'error')).toEqual([]);
    contract = out.sources['RepIDStaking.sol'].ast.nodes.find((n: Node) => n.nodeType === 'ContractDefinition' && n.name === 'RepIDStaking');
    fns = contract.nodes.filter((n: Node) => n.nodeType === 'FunctionDefinition');
  }, 60_000);

  const fn = (name: string) => {
    const f = fns.find((x) => x.name === name);
    if (!f) throw new Error(`no function ${name}`);
    return f;
  };

  test('POSITIVE CONTROL: the detector sees msg.sender where it is read (stake, line 35)', () => {
    expect(lineOf(fn('stake'))).toBe(35);
    expect(reads(fn('stake').body, 'sender', 'msg')).toBe(true);
  });

  test.each([['approve', 50], ['slash', 58]] as const)('%s (line %i) is external with no caller check', (name, line) => {
    const f = fn(name);
    expect(lineOf(f)).toBe(line);
    expect(f.visibility).toBe('external');
    expect(f.modifiers).toEqual([]);
    expect(reads(f.body, 'sender', 'msg')).toBe(false);
    expect(reads(f.body, 'origin', 'tx')).toBe(false);
  });

  test('the contract has no owner, no role, and no modifier anywhere', () => {
    expect(contract.nodes.filter((n: Node) => n.nodeType === 'ModifierDefinition')).toEqual([]);
    expect(fns.map((f) => f.name).filter((n) => /owner|role|admin|withdraw|pause/i.test(String(n)))).toEqual([]);
  });

  test('only approve moves ETH out, so slashed stakes are locked for good', () => {
    const senders = fns.filter((f) => {
      let moves = false;
      walk(f.body, (x) => { if (x.nodeType === 'MemberAccess' && ['transfer', 'send', 'call'].includes(String(x.memberName))) moves = true; });
      return moves;
    });
    expect(senders.map((f) => f.name)).toEqual(['approve']);
  });

  test('identityRegistry is stored and never read by any function', () => {
    const readers = fns.filter((f) => f.kind !== 'constructor').filter((f) => {
      let hit = false;
      walk(f.body, (x) => { if (x.nodeType === 'Identifier' && x.name === 'identityRegistry') hit = true; });
      return hit;
    });
    expect(readers.map((f) => f.name)).toEqual([]);
  });
});
