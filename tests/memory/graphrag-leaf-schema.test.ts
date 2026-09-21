import {
  encodeEntityLeaf, entityLeafValue,
  encodeRelationLeaf, relationLeafValue,
  encodeEpisodeLeaf, episodeLeafValue,
  encodeSkillLeaf, skillLeafValue,
  graphEdgeHash, verifyWalkStep,
  type EntityLeaf, type RelationLeaf, type EpisodeLeaf, type SkillLeaf, type WalkStep,
} from '../../src/memory/graphrag-leaf-schema';

const entity: EntityLeaf = {
  entity_id: 'e1',
  entity_type: 'person',
  name: 'Alice',
  description: 'Test entity',
  embedding_hash: 'abc123',
  epoch: 1,
};

describe('EntityLeaf', () => {
  it('encodes deterministically', () => {
    expect(encodeEntityLeaf(entity)).toBe(encodeEntityLeaf({ ...entity }));
  });

  it('different entity_id produces different value', () => {
    expect(entityLeafValue(entity)).not.toBe(entityLeafValue({ ...entity, entity_id: 'e2' }));
  });

  it('different epoch produces different value', () => {
    expect(entityLeafValue(entity)).not.toBe(entityLeafValue({ ...entity, epoch: 2 }));
  });

  it('value is a non-empty string', () => {
    const v = entityLeafValue(entity);
    expect(typeof v).toBe('string');
    expect(v.length).toBeGreaterThan(0);
  });
});

describe('RelationLeaf', () => {
  const from_v = entityLeafValue(entity);
  const to_v = entityLeafValue({ ...entity, entity_id: 'e2', name: 'Bob' });

  const relation: RelationLeaf = {
    relation_id: 'r1',
    from_value: from_v,
    relation_type: 'knows',
    to_value: to_v,
    confidence: 0.9,
    epoch: 1,
  };

  it('encodes deterministically', () => {
    expect(encodeRelationLeaf(relation)).toBe(encodeRelationLeaf({ ...relation }));
  });

  it('different relation_type produces different value', () => {
    expect(relationLeafValue(relation)).not.toBe(
      relationLeafValue({ ...relation, relation_type: 'trusts' }),
    );
  });

  it('binds from_value so a changed source entity changes the relation commitment', () => {
    const altered_from = entityLeafValue({ ...entity, epoch: 99 });
    expect(relationLeafValue(relation)).not.toBe(
      relationLeafValue({ ...relation, from_value: altered_from }),
    );
  });
});

describe('EpisodeLeaf', () => {
  const p1 = entityLeafValue(entity);
  const p2 = entityLeafValue({ ...entity, entity_id: 'e2', name: 'Bob' });

  const episode: EpisodeLeaf = {
    episode_id: 'ep1',
    content: 'Alice met Bob',
    participant_values: [p1, p2],
    timestamp_ms: 1000000,
    hal_verdict: 'clean',
    epoch: 1,
  };

  it('encodes deterministically regardless of participant order', () => {
    const swapped: EpisodeLeaf = { ...episode, participant_values: [p2, p1] };
    // participant_values are sorted before encoding so order does not matter
    expect(encodeEpisodeLeaf(episode)).toBe(encodeEpisodeLeaf(swapped));
  });

  it('different content produces different value', () => {
    expect(episodeLeafValue(episode)).not.toBe(
      episodeLeafValue({ ...episode, content: 'Alice met Charlie' }),
    );
  });

  it('different hal_verdict produces different value', () => {
    expect(episodeLeafValue(episode)).not.toBe(
      episodeLeafValue({ ...episode, hal_verdict: 'flagged' }),
    );
  });
});

describe('SkillLeaf', () => {
  const skill: SkillLeaf = {
    skill_id: 'sk1',
    description: 'Code review',
    capability_vector_hash: 'deadbeef',
    proficiency_score: 0.8,
    epoch: 1,
  };

  it('encodes deterministically', () => {
    expect(encodeSkillLeaf(skill)).toBe(encodeSkillLeaf({ ...skill }));
  });

  it('different capability_vector_hash produces different value', () => {
    expect(skillLeafValue(skill)).not.toBe(
      skillLeafValue({ ...skill, capability_vector_hash: 'cafebabe' }),
    );
  });
});

describe('GraphEdge and WalkStep', () => {
  const from_v = entityLeafValue(entity);
  const to_v = entityLeafValue({ ...entity, entity_id: 'e2', name: 'Bob' });

  it('graphEdgeHash is deterministic', () => {
    expect(graphEdgeHash({ from_value: from_v, relation_type: 'knows', to_value: to_v })).toBe(
      graphEdgeHash({ from_value: from_v, relation_type: 'knows', to_value: to_v }),
    );
  });

  it('different relation_type produces different edge hash', () => {
    expect(graphEdgeHash({ from_value: from_v, relation_type: 'knows', to_value: to_v })).not.toBe(
      graphEdgeHash({ from_value: from_v, relation_type: 'trusts', to_value: to_v }),
    );
  });

  it('verifyWalkStep returns true for a correctly committed step', () => {
    const edge_hash = graphEdgeHash({ from_value: from_v, relation_type: 'knows', to_value: to_v });
    const step: WalkStep = { from_value: from_v, relation_type: 'knows', to_value: to_v, edge_hash };
    expect(verifyWalkStep(step)).toBe(true);
  });

  it('verifyWalkStep returns false when edge_hash is tampered', () => {
    const step: WalkStep = {
      from_value: from_v,
      relation_type: 'knows',
      to_value: to_v,
      edge_hash: 'tampered',
    };
    expect(verifyWalkStep(step)).toBe(false);
  });

  it('verifyWalkStep returns false when relation_type is changed after hash is set', () => {
    const edge_hash = graphEdgeHash({ from_value: from_v, relation_type: 'knows', to_value: to_v });
    const step: WalkStep = { from_value: from_v, relation_type: 'trusts', to_value: to_v, edge_hash };
    expect(verifyWalkStep(step)).toBe(false);
  });

  it('swapping from_value and to_value produces a different edge hash', () => {
    expect(graphEdgeHash({ from_value: from_v, relation_type: 'knows', to_value: to_v })).not.toBe(
      graphEdgeHash({ from_value: to_v, relation_type: 'knows', to_value: from_v }),
    );
  });
});
