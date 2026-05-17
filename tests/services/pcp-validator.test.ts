import { runPCP, selectWeightedValidators } from '../../src/services/pcp-validator';
import { db } from '../../src/db';

jest.mock('../../src/db', () => ({
  db: {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockResolvedValue({
      data: [
        { agent_name: 'Alpha', current_repid: 1000 },
        { agent_name: 'Beta', current_repid: 800 },
        { agent_name: 'Gamma', current_repid: 600 },
        { agent_name: 'Delta', current_repid: 200 }, // too low repid
        { agent_name: 'ClaimerBot', current_repid: 900 } // claimer
      ],
      error: null
    })
  }
}));

// Mock global fetch
global.fetch = jest.fn();

describe('pcp-validator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GROQ_API_KEY = 'test-key';
  });

  describe('selectWeightedValidators', () => {
    it('selects exactly the requested number of validators if available', () => {
      const agents = [
        { agent_name: 'A', current_repid: 1000 },
        { agent_name: 'B', current_repid: 800 },
        { agent_name: 'C', current_repid: 600 }
      ];
      const selected = selectWeightedValidators(agents, 2);
      expect(selected.length).toBe(2);
      expect(selected[0].agent_name).not.toBe(selected[1].agent_name);
    });

    it('returns all available if requested count exceeds pool size', () => {
      const agents = [
        { agent_name: 'A', current_repid: 1000 }
      ];
      const selected = selectWeightedValidators(agents, 3);
      expect(selected.length).toBe(1);
    });

    it('favors higher repid agents (probabilistic but bounded)', () => {
      const agents = [
        { agent_name: 'High', current_repid: 1000000 },
        { agent_name: 'Low', current_repid: 1 }
      ];
      const selected = selectWeightedValidators(agents, 1);
      // It's almost guaranteed to pick 'High', though it's stochastic
      expect(selected[0].agent_name).toBe('High');
    });
  });

  describe('runPCP', () => {
    it('filters out the claimer and agents with repid < 500', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        json: jest.fn().mockResolvedValue({
          choices: [{ message: { content: '{"validity": 0.9, "confidence": 0.95, "justification": "Looks good"}' } }]
        })
      });

      const taskData = { claimed_by: 'ClaimerBot', title: 'Test Task', description: 'Desc', result: 'Res' };
      const res = await runPCP(taskData);

      expect(res.validators).not.toContain('ClaimerBot');
      expect(res.validators).not.toContain('Delta');
      expect(res.score).toBeGreaterThan(0);
    });

    it('handles LLM JSON parsing failures gracefully', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        json: jest.fn().mockResolvedValue({
          choices: [{ message: { content: 'I am a bad AI and I output no JSON' } }]
        })
      });

      const taskData = { claimed_by: 'ClaimerBot', title: 'Test Task', description: 'Desc', result: 'Res' };
      const res = await runPCP(taskData);

      expect(res.score).toBe(0);
      expect(res.confidence).toBe(0);
      expect(res.validators.length).toBeGreaterThan(0);
    });

    it('aggregates scores correctly based on confidence weighting', async () => {
      // Mock fetch to return specific scores depending on the prompt or just cycle them
      let callCount = 0;
      (global.fetch as jest.Mock).mockImplementation(() => {
        callCount++;
        let validity = 0.5;
        let confidence = 0.5;
        
        if (callCount === 1) {
          validity = 1.0;
          confidence = 1.0;
        } else if (callCount === 2) {
          validity = 0.0;
          confidence = 0.5;
        } else {
          validity = 0.8;
          confidence = 0.8;
        }

        return Promise.resolve({
          json: () => Promise.resolve({
            choices: [{ message: { content: `{"validity": ${validity}, "confidence": ${confidence}, "justification": "ok"}` } }]
          })
        });
      });

      const taskData = { claimed_by: 'ClaimerBot', title: 'Test Task', description: 'Desc', result: 'Res' };
      const res = await runPCP(taskData);

      // (1.0*1.0 + 0.0*0.5 + 0.8*0.8) / (1.0 + 0.5 + 0.8)
      // (1.0 + 0 + 0.64) / 2.3 = 1.64 / 2.3 = 0.713
      expect(res.score).toBeCloseTo(1.64 / 2.3);
      expect(res.confidence).toBeCloseTo(2.3 / 3);
    });
  });
});
