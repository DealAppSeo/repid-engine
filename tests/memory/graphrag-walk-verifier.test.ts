/**
 * Tests for verifyAuthenticatedWalk (item 12, backlog acceptance test:
 * "a multi-hop walk verifies hop-by-hop against the root").
 */

import { LeanIMTPlus } from '../../src/memory/leanimt-plus';
import {
  EntityLeaf,
  entityLeafValue,
  graphEdgeHash,
  WalkStep,
  verifyAuthenticatedWalk,
} from '../../src/memory/graphrag-leaf-schema';

function makeEntity(id: string, name: string): EntityLeaf {
  return { entity_id: id, entity_type: 'concept', name, description: `desc-${name}`, embedding_hash: '0'.repeat(64), epoch: 1 };
}

function buildTree(...hexValues: string[]): LeanIMTPlus {
  const tree = new LeanIMTPlus();
  for (const v of hexValues) tree.insert(BigInt(v));
  return tree;
}

function makeStep(fromV: string, toV: string, relType = 'is_a'): WalkStep {
  return {
    from_value: fromV,
    relation_type: relType,
    to_value: toV,
    edge_hash: graphEdgeHash({ from_value: fromV, relation_type: relType, to_value: toV }),
  };
}

const eA = makeEntity('a', 'A');
const eB = makeEntity('b', 'B');
const eC = makeEntity('c', 'C');
const vA = entityLeafValue(eA);
const vB = entityLeafValue(eB);
const vC = entityLeafValue(eC);

describe('verifyAuthenticatedWalk', () => {
  it('empty walk is trivially valid', () => {
    const tree = buildTree(vA);
    const result = verifyAuthenticatedWalk([], tree);
    expect(result.valid).toBe(true);
    expect(result.steps).toHaveLength(0);
    expect(result.failAt).toBeUndefined();
  });

  it('single valid step — both nodes in tree, edge hash correct', () => {
    const tree = buildTree(vA, vB);
    const step = makeStep(vA, vB);
    const result = verifyAuthenticatedWalk([step], tree);
    expect(result.valid).toBe(true);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.edgeHashValid).toBe(true);
    expect(result.steps[0]!.fromNodeIncluded).toBe(true);
    expect(result.steps[0]!.toNodeIncluded).toBe(true);
    expect(result.failAt).toBeUndefined();
  });

  it('fails when edge hash is tampered', () => {
    const tree = buildTree(vA, vB);
    const step: WalkStep = { from_value: vA, relation_type: 'is_a', to_value: vB, edge_hash: '0x' + '0'.repeat(64) };
    const result = verifyAuthenticatedWalk([step], tree);
    expect(result.valid).toBe(false);
    expect(result.failAt).toBe(0);
    expect(result.steps[0]!.edgeHashValid).toBe(false);
  });

  it('fails when from_value is not in tree', () => {
    const tree = buildTree(vB); // vA not inserted
    const step = makeStep(vA, vB);
    const result = verifyAuthenticatedWalk([step], tree);
    expect(result.valid).toBe(false);
    expect(result.failAt).toBe(0);
    expect(result.steps[0]!.fromNodeIncluded).toBe(false);
  });

  it('fails when to_value is not in tree', () => {
    const tree = buildTree(vA); // vB not inserted
    const step = makeStep(vA, vB);
    const result = verifyAuthenticatedWalk([step], tree);
    expect(result.valid).toBe(false);
    expect(result.failAt).toBe(0);
    expect(result.steps[0]!.toNodeIncluded).toBe(false);
  });

  it('3-hop walk all valid', () => {
    const tree = buildTree(vA, vB, vC);
    const steps = [makeStep(vA, vB), makeStep(vB, vC)];
    const result = verifyAuthenticatedWalk(steps, tree);
    expect(result.valid).toBe(true);
    expect(result.steps).toHaveLength(2);
    expect(result.failAt).toBeUndefined();
  });

  it('3-hop walk fails at middle step (index 1) with correct failAt', () => {
    const tree = buildTree(vA, vB, vC);
    const eD = makeEntity('d', 'D');
    const vD = entityLeafValue(eD); // not in tree
    const steps = [
      makeStep(vA, vB),        // step 0: valid
      makeStep(vB, vD),        // step 1: vD not in tree → fails
      makeStep(vD, vC),        // step 2: never reached
    ];
    const result = verifyAuthenticatedWalk(steps, tree);
    expect(result.valid).toBe(false);
    expect(result.failAt).toBe(1);
    expect(result.steps).toHaveLength(2); // only steps 0 and 1 recorded
    expect(result.steps[0]!.valid).toBe(true);
    expect(result.steps[1]!.valid).toBe(false);
  });

  it('never throws for any valid input', () => {
    const tree = buildTree(vA);
    // edge case: empty tree with actual step
    const treeEmpty = new LeanIMTPlus();
    expect(() => verifyAuthenticatedWalk([makeStep(vA, vB)], treeEmpty)).not.toThrow();
    // single node, self-referential step
    const selfStep = makeStep(vA, vA);
    expect(() => verifyAuthenticatedWalk([selfStep], tree)).not.toThrow();
  });
});
