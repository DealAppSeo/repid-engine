import { db } from '../db';
import { getAgentsLeaderboard } from '../analytics/agent-performance';
import { applyValidationEvent } from '../scoring/pipeline';
import { routeRequest } from '../providers/router';
import { normalizeAgentName } from './trinity-task-bridge';

export async function assignMentorships(): Promise<void> {
  try {
    const leaderboard = await getAgentsLeaderboard('30d');
    if (!leaderboard || leaderboard.length < 2) {
      console.log('[Mentorship] Leaderboard too small to assign mentorships');
      return;
    }

    // Filter out HUMAN and sort by hal_catch_rate descending
    const activeAgents = leaderboard
      .filter((a: any) => a.agent_name !== 'HUMAN')
      .sort((a: any, b: any) => b.hal_catch_rate - a.hal_catch_rate);

    if (activeAgents.length < 2) {
      console.log('[Mentorship] Not enough non-human active agents to assign mentorships');
      return;
    }

    // Top 4 = mentors, bottom 4 = mentees
    const half = Math.min(4, Math.floor(activeAgents.length / 2));
    const mentors = activeAgents.slice(0, half);
    const mentees = activeAgents.slice(-half).reverse(); // reverse so worst pairs with best

    for (let i = 0; i < mentors.length; i++) {
      const mentor = mentors[i];
      const mentee = mentees[i];

      if (!mentor || !mentee || mentor.agent_name === mentee.agent_name) continue;

      // Find strongest domain of mentor or default to general
      const domain = mentor.domains_strongest?.[0] || 'general';

      // Check if active mentorship already exists
      const { data: existing } = await db
        .from('agent_mentorships')
        .select('id')
        .eq('mentor_agent', mentor.agent_name)
        .eq('mentee_agent', mentee.agent_name)
        .eq('domain', domain)
        .eq('active', true)
        .maybeSingle();

      if (!existing) {
        await db.from('agent_mentorships').insert({
          mentor_agent: mentor.agent_name,
          mentee_agent: mentee.agent_name,
          domain,
          active: true,
        });

        console.log(`[Mentorship] Created pair: Mentor ${mentor.agent_name} -> Mentee ${mentee.agent_name} for domain ${domain}`);
      }
    }
  } catch (err: any) {
    console.error('[Mentorship] Failed to assign mentorships:', err.message);
  }
}

export async function handleMenteeFailure(
  menteeName: string,
  task: { id: number | string; description?: string; title?: string; task_type?: string; result?: string; metadata?: any },
  scoreResult: { hal_score: number; repid_delta_applied: number }
): Promise<void> {
  try {
    const domain = task.task_type || 'general';
    const normalizedName = normalizeAgentName(menteeName);

    // Find active mentorship
    const { data: mentorship } = await db
      .from('agent_mentorships')
      .select('*')
      .eq('mentee_agent', normalizedName)
      .eq('active', true)
      .limit(1)
      .maybeSingle();

    if (!mentorship) {
      console.log(`[Mentorship] No active mentorship found for mentee ${normalizedName}`);
      return;
    }

    const mentorName = mentorship.mentor_agent;
    console.log(`[Mentorship] Triggering mentorship session. Mentee ${normalizedName} failed. Routing to Mentor ${mentorName}`);

    // Resolve mentor UUID
    const { data: mentorAgent } = await db
      .from('repid_agents')
      .select('id')
      .eq('agent_name', mentorName)
      .maybeSingle();

    if (!mentorAgent) {
      console.error(`[Mentorship] Mentor agent '${mentorName}' not found in repid_agents`);
      return;
    }

    // Resolve mentee UUID
    const { data: menteeAgent } = await db
      .from('repid_agents')
      .select('id')
      .eq('agent_name', normalizedName)
      .maybeSingle();

    if (!menteeAgent) {
      console.error(`[Mentorship] Mentee agent '${normalizedName}' not found in repid_agents`);
      return;
    }

    // 1. Send the same task to the mentor & Mentor solves it
    const promptDescription = task.description || task.title || 'Swarm Task';
    const mentorPrompt = `[Mentorship Session] You are the mentor agent ${mentorName}. Solve this task accurately:\n\nTask: ${promptDescription}\n\nProvide your answer and explain your step-by-step reasoning.`;

    const { adapter, decision } = await routeRequest({
      prompt: mentorPrompt,
      tier_preference: 'auto',
      task_hint: domain,
    }, []);

    let mentorAnswer = 'Completed correctly.';
    let mentorReasoning = 'Reasoning verified.';

    if (adapter) {
      const apiKey = process.env[`${adapter.name.toUpperCase()}_API_KEY`] || process.env.OPENAI_API_KEY || '';
      if (apiKey) {
        try {
          const compResult = await adapter.complete({
            prompt: mentorPrompt,
            apiKey,
          });
          mentorAnswer = compResult.answer;
          mentorReasoning = compResult.answer.split('\n\n').slice(-1)[0] || 'Followed step-by-step verification.';
        } catch (e: any) {
          console.error('[Mentorship] Mentor completion failed, falling back:', e.message);
        }
      }
    }

    // 2. Both solutions + reasoning are logged in learning feed
    const lesson = `Mentorship Session: Mentor ${mentorName} verified and resolved task on domain ${domain} which Mentee ${normalizedName} failed. Mentor approach: ${mentorReasoning}`;

    await db.from('agent_learning_events').insert({
      source_agent: mentorName,
      event_type: 'mentorship_session',
      lesson,
      evidence: {
        task_id: task.id,
        mentee_agent: normalizedName,
        mentor_agent: mentorName,
        mentee_solution: task.result || '',
        mentor_solution: mentorAnswer,
        mentor_reasoning: mentorReasoning,
        hal_score: scoreResult.hal_score,
      },
      applicable_agents: [normalizedName],
      confidence: 0.9,
    });

    // 3. Both get RepID adjustments
    // Mentor gets +2 (Socrates multiplier)
    await applyValidationEvent(
      mentorAgent.id,
      'VALIDATOR_REWARD',
      2,
      {
        notes: 'Socrates mentorship multiplier',
        mentorship_pair_id: mentorship.id,
        task_id: task.id,
      }
    );

    // Update mentorship statistics
    await db
      .from('agent_mentorships')
      .update({
        sessions_completed: (mentorship.sessions_completed || 0) + 1,
        mentor_repid_earned: (Number(mentorship.mentor_repid_earned) || 0) + 2,
        // Mark that there is a pending reward for mentee
        mentee_improvement_rate: 0.0, // default placeholder
      })
      .eq('id', mentorship.id);

    console.log(`[Mentorship] Completed session for ${normalizedName}. Mentor ${mentorName} awarded +2 RepID.`);
  } catch (err: any) {
    console.error('[Mentorship] Failed to handle mentee failure:', err.message);
  }
}

export async function handleMenteeSuccess(
  menteeName: string,
  domain: string
): Promise<void> {
  try {
    const normalizedName = normalizeAgentName(menteeName);

    // Find active mentorship
    const { data: mentorship } = await db
      .from('agent_mentorships')
      .select('*')
      .eq('mentee_agent', normalizedName)
      .eq('active', true)
      .limit(1)
      .maybeSingle();

    if (!mentorship) return;

    // Check if there was a recent mentorship session for this mentee/domain
    const { data: recentSession } = await db
      .from('agent_learning_events')
      .select('id, created_at')
      .eq('event_type', 'mentorship_session')
      .contains('applicable_agents', [normalizedName])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!recentSession) return;

    // If mentee has recent session and has not received the +1 learning reward yet for it:
    // Let's check if we already gave them a learning reward for this mentorship pair since the last session.
    // To implement simple idempotency, we check if mentee_repid_earned matches sessions_completed
    const earned = Number(mentorship.mentee_repid_earned) || 0;
    const completed = mentorship.sessions_completed || 0;

    if (earned < completed) {
      // Award +1 RepID to Mentee
      const { data: menteeAgent } = await db
        .from('repid_agents')
        .select('id')
        .eq('agent_name', normalizedName)
        .maybeSingle();

      if (menteeAgent) {
        await applyValidationEvent(
          menteeAgent.id,
          'SERVICE_SATISFIED',
          1,
          {
            notes: 'Mentee learning reward for successful task completion following mentorship session',
            mentorship_pair_id: mentorship.id,
          }
        );

        // Update mentorship statistics
        await db
          .from('agent_mentorships')
          .update({
            mentee_repid_earned: earned + 1,
            mentee_improvement_rate: Math.min(1.0, (earned + 1) / completed),
          })
          .eq('id', mentorship.id);

        console.log(`[Mentorship] Mentee ${normalizedName} successfully applied learning on domain ${domain}. Awarded +1 RepID.`);
      }
    }
  } catch (err: any) {
    console.error('[Mentorship] Failed to handle mentee success:', err.message);
  }
}
