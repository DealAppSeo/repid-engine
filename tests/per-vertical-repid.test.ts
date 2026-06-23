import { get_vertical_repid, can_act_in_vertical } from '../src/services/vertical-repid';
import { pgQuery } from '../src/db/direct-pg';

jest.mock('../src/db/direct-pg');

describe('per-vertical reputation engine & gates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('get_vertical_repid', () => {
    it('returns 0 if agent or domain accuracy is missing', async () => {
      (pgQuery as jest.Mock).mockResolvedValue([]);
      const score = await get_vertical_repid('mock-uuid', 'medical');
      expect(score).toBe(0);
    });

    it('returns correct vertical percentage if present', async () => {
      (pgQuery as jest.Mock).mockResolvedValue([
        {
          domain_accuracy: {
            medical: { pct: 85.5, count: 5 }
          }
        }
      ]);
      const score = await get_vertical_repid('mock-uuid', 'medical');
      expect(score).toBe(85.5);
    });
  });

  describe('can_act_in_vertical', () => {
    it('denies action for mock agents', async () => {
      (pgQuery as jest.Mock).mockResolvedValue([
        {
          agent_name: 'trinity-agent-mock-001',
          agent_type: 'external',
          current_repid: 1200
        }
      ]);
      const allowed = await can_act_in_vertical('mock-uuid', 'medical', 80);
      expect(allowed).toBe(false);
    });

    it('denies action for perceived-only agents', async () => {
      (pgQuery as jest.Mock).mockResolvedValue([
        {
          agent_name: 'trinity-agent-a',
          agent_type: 'perceived',
          current_repid: 1500
        }
      ]);
      const allowed = await can_act_in_vertical('mock-uuid', 'medical', 80);
      expect(allowed).toBe(false);
    });

    it('denies action in medical/finance if overall RepID is below 1000', async () => {
      (pgQuery as jest.Mock).mockImplementation((query: string) => {
        if (query.includes('domain_accuracy')) {
          return Promise.resolve([
            {
              domain_accuracy: { medical: { pct: 95.0, count: 10 } }
            }
          ]);
        }
        return Promise.resolve([
          {
            agent_name: 'trinity-agent-real',
            agent_type: 'external',
            current_repid: 500 // EARNING tier (below 1000)
          }
        ]);
      });

      const allowed = await can_act_in_vertical('mock-uuid', 'medical', 80);
      expect(allowed).toBe(false);
    });

    it('denies action if vertical accuracy score is below minScore', async () => {
      (pgQuery as jest.Mock).mockImplementation((query: string) => {
        if (query.includes('domain_accuracy')) {
          return Promise.resolve([
            {
              domain_accuracy: { medical: { pct: 75.0, count: 10 } } // 75% accuracy
            }
          ]);
        }
        return Promise.resolve([
          {
            agent_name: 'trinity-agent-real',
            agent_type: 'external',
            current_repid: 2500
          }
        ]);
      });

      const allowed = await can_act_in_vertical('mock-uuid', 'medical', 80); // requires 80%
      expect(allowed).toBe(false);
    });

    it('allows action if all gates (vertical score, earned score, real agent) are passed', async () => {
      (pgQuery as jest.Mock).mockImplementation((query: string) => {
        if (query.includes('domain_accuracy')) {
          return Promise.resolve([
            {
              domain_accuracy: { medical: { pct: 88.0, count: 10 } }
            }
          ]);
        }
        return Promise.resolve([
          {
            agent_name: 'trinity-agent-real',
            agent_type: 'external',
            current_repid: 2500
          }
        ]);
      });

      const allowed = await can_act_in_vertical('mock-uuid', 'medical', 80);
      expect(allowed).toBe(true);
    });
  });
});
