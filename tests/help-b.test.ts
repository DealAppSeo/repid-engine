import { readHelpB } from '../src/services/help-b';

describe('help B schema', () => {
  it('missing n is NOT_CHECKED, not 0', () => {
    const missing = readHelpB({
      rater_type: 'human',
      subject: 'family',
      dim: 'helpful',
      value: 0.8,
    });
    expect(missing.status).toBe('NOT_CHECKED');
    expect(missing.n).toBeNull();
    expect(missing.value).not.toBe(0);
    expect(missing.value).toBeNull();

    const zeroN = readHelpB({
      rater_type: 'agent',
      subject: 'agent',
      dim: 'accurate',
      value: 0,
      n: 0,
    });
    expect(zeroN.status).toBe('NOT_CHECKED');
    expect(zeroN.value).toBeNull();
  });

  it('a counted rating keeps its value and does not score an agent by itself', () => {
    const row = readHelpB({
      rater_type: 'human',
      subject: 'agent',
      dim: 'deep',
      value: 0.5,
      n: 3,
    });
    expect(row).toEqual({
      rater_type: 'human',
      subject: 'agent',
      dim: 'deep',
      value: 0.5,
      n: 3,
      status: 'recorded',
    });
  });

  it('does not treat a value outside 0 to 1 as a rating', () => {
    const high = readHelpB({
      rater_type: 'human',
      subject: 'family',
      dim: 'helpful',
      value: 2,
      n: 4,
    });
    expect(high.status).toBe('NOT_CHECKED');
    expect(high.value).toBeNull();
  });
});
