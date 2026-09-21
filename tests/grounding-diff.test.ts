import { diffGrounded } from '../scripts/grounding/diff-report';

describe('C8 A6 diff report', () => {
  it('counts agents whose grounded score would move', () => {
    const { moved, floor_usd } = diffGrounded([
      { agent_id: '00000000-0000-4000-8000-0000000000aa', current_repid: 0, g_verified: 0, delta: 25 },
      { agent_id: '00000000-0000-4000-8000-0000000000aa', current_repid: 0, g_verified: 'high', delta: 10 },
      { agent_id: '00000000-0000-4000-8000-0000000000ab', current_repid: 0, g_verified: 'high', delta: 5 },
    ]);
    expect(floor_usd).toBe(0.1);
    expect(moved).toHaveLength(1);
    expect(moved[0]!.agent_id).toBe('00000000-0000-4000-8000-0000000000aa');
    expect(moved[0]!.delta).toBe(-25);
  });
});
