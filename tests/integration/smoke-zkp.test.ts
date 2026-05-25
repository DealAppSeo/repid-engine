
import { runScoreEvent } from '../../src/scoring/pipeline';
import { db } from '../../src/db';
import crypto from 'crypto';

// Env-guard (matches the other integration suites, e.g. repid-earning / zkp-attestation):
// this is a REAL integration test — it inserts an agent, runs the scoring pipeline, and
// reads repid_proof_queue against the live DB — so it must SKIP (not fail) when CI lacks
// Supabase creds. We deliberately do NOT mock the db (that would defeat the integration
// test, unlike the verify-proof unit-test fix). Test logic is unchanged.
const HAS_DB = !!(process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY));
const describeIfDb = HAS_DB ? describe : describe.skip;

describeIfDb('ZKP Proof Orchestration Smoke Test', () => {
  const testAgentId = crypto.randomUUID();

  beforeAll(async () => {
    console.log('Creating test agent:', testAgentId);
    // Create test agent
    const { data, error } = await db.from('repid_agents').insert({
      id: testAgentId,
      agent_name: 'Z2 Smoke Agent',
      current_repid: 1000,
      tier: 'CUSTODIED_DBT',
      erc8004_address: '0x' + crypto.randomBytes(20).toString('hex'),
      constitution: { version: '1.0', type: 'AGENT' }
    }).select();
    
    if (error) {
      console.error('Agent creation failed:', error);
    } else {
      console.log('Agent created successfully:', data);
    }
  });

  afterAll(async () => {
    // Cleanup
    await db.from('repid_score_events').delete().eq('agent_id', testAgentId);
    await db.from('repid_proof_queue').delete().eq('agent_id', testAgentId);
    await db.from('repid_agents').delete().eq('id', testAgentId);
  });

  it('should trigger a ZK proof job on significant score event', async () => {
    const result = await runScoreEvent({
      agent_id: testAgentId,
      prompt: 'Test prompt',
      answer: 'Test answer that is very helpful and aligned with the constitution.',
      task_domain: 'finance',
      certainty: 0.95
    });

    expect(result.zk_proof_triggered).toBe(true);
    expect(result.zk_proof_id).toBeDefined();

    // Wait for background insert
    await new Promise(r => setTimeout(r, 2000));

    // Verify job exists in queue
    const { data: job, error } = await db
      .from('repid_proof_queue')
      .select('*')
      .eq('job_id', result.zk_proof_id)
      .single();

    expect(error).toBeNull();
    expect(job).toBeDefined();
    expect(job.status).toBe('pending');
    expect(job.agent_id).toBe(testAgentId);
    expect(job.zkp_service_url).toContain('zkp-postcard-production.up.railway.app');
  });
});
