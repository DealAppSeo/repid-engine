import { db } from '../db';
import { sendTelegramAlert } from '../routes/telegram';

// Controller escalation ladder (CC2 2026-05-26). Implements the sprint taxonomy:
//   agent_internal  → agent retries; no escalation recorded.
//   squad_internal  → squad peer-review (Gemini's peer verification) — recorded only.
//   cross_squad     → peer verification across squads (Gemini's amendment) — recorded only.
//   code_agent      → failed cross-squad → autonomous_tasks(assigned_to in cc|gemini), no Sean approval.
//   sean            → failed code-agent OR strategic → autonomous_tasks(assigned_to='sean',
//                     requires_sean_approval=true) + Telegram alert via ORCH.
// autonomous_tasks has no `task_type` column (verified) → routing uses assigned_to +
// requires_sean_approval. The Telegram link points at the controller UI route.

export type EscalationLevel = 'agent_internal' | 'squad_internal' | 'cross_squad' | 'code_agent' | 'sean';

export interface EscalationInput {
  agent_id: string;
  task_id?: number;
  level: EscalationLevel;
  summary: string;
  detail?: string;
  assignee?: 'cc' | 'gemini'; // for code_agent level; defaults to cc
}

export interface EscalationResult {
  routed: boolean;
  level: EscalationLevel;
  escalation_id?: number;
  routed_to?: string | null;
  autonomous_task_id?: number | null;
  telegram_sent?: boolean;
  reason?: string;
}

const CONTROLLER_BASE = process.env.CONTROLLER_APP_URL || 'https://controller.aitrinitysymphony.com';

export async function routeEscalation(input: EscalationInput): Promise<EscalationResult> {
  const { agent_id, task_id, level, summary, detail } = input;

  // agent-internal: the agent retries on its own — nothing to escalate or record.
  if (level === 'agent_internal') {
    return { routed: false, level, reason: 'agent-internal — agent retries, no escalation' };
  }

  let routed_to: string | null = null;
  let autonomous_task_id: number | null = null;

  if (level === 'squad_internal') {
    routed_to = 'squad'; // handled by squad peer-review (Gemini)
  } else if (level === 'cross_squad') {
    routed_to = 'cross_squad'; // cross-squad peer verification (Gemini)
  } else if (level === 'code_agent') {
    routed_to = input.assignee === 'gemini' ? 'gemini' : 'cc';
    const { data } = await db
      .from('autonomous_tasks')
      .insert({
        created_by: 'controller-escalation',
        assigned_to: routed_to,
        title: `[ESCALATION] ${agent_id}: ${summary}`.slice(0, 200),
        description: detail || summary,
        status: 'pending',
        requires_sean_approval: false,
      })
      .select('id')
      .single();
    autonomous_task_id = data?.id ?? null;
  } else if (level === 'sean') {
    routed_to = 'sean';
    const { data } = await db
      .from('autonomous_tasks')
      .insert({
        created_by: 'controller-escalation',
        assigned_to: 'sean',
        title: `[SEAN] ${agent_id}: ${summary}`.slice(0, 200),
        description: detail || summary,
        status: 'pending',
        requires_sean_approval: true,
      })
      .select('id')
      .single();
    autonomous_task_id = data?.id ?? null;
  }

  // Record the escalation.
  const { data: esc } = await db
    .from('controller_escalations')
    .insert({
      agent_id,
      task_id: task_id ?? null,
      level,
      summary,
      detail: detail ?? null,
      routed_to,
      status: 'routed',
      autonomous_task_id,
      telegram_sent: false,
    })
    .select('id')
    .single();
  const escalation_id = esc?.id;

  // Sean-level → short Telegram alert with a controller deep-link.
  let telegram_sent = false;
  if (level === 'sean' && escalation_id) {
    const msg =
      `🚨 <b>Escalation → Sean</b>\n` +
      `Agent: <code>${agent_id}</code>${task_id ? ` · task ${task_id}` : ''}\n` +
      `${summary}\n` +
      `<a href="${CONTROLLER_BASE}/escalation/${escalation_id}">Open in controller</a>`;
    try {
      await sendTelegramAlert(msg);
      telegram_sent = true;
      await db.from('controller_escalations').update({ telegram_sent: true }).eq('id', escalation_id);
    } catch (e) {
      // Telegram failure must not lose the escalation record.
    }
  }

  return { routed: true, level, escalation_id, routed_to, autonomous_task_id, telegram_sent };
}
