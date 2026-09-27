/**
 * Preview of a bind signature. An empty bind is 401.
 * The message names the wallet and the agent. This module inserts nothing.
 */

export interface BindPreview {
  status: 401 | 200;
  applied: false;
  persisted: false;
  wallet: string | null;
  agent: string | null;
  message: string | null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function previewBind(body: unknown): BindPreview {
  const rec = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const wallet = text(rec.wallet);
  const agent = text(rec.agent_id);
  const signature = text(rec.signature);
  if (!wallet || !agent || !signature) {
    return {
      status: 401,
      applied: false,
      persisted: false,
      wallet: wallet || null,
      agent: agent || null,
      message: null,
    };
  }
  const message = [
    'HyperDAG — bind agent to human',
    '',
    `wallet: ${wallet.toLowerCase()}`,
    `agent:  ${agent}`,
    'scope:  ownership',
    '',
    'Signing this proves you control this wallet and claims ownership of this agent.',
    'It moves no funds and grants no spending authority.',
  ].join('\n');
  return {
    status: 200,
    applied: false,
    persisted: false,
    wallet: wallet.toLowerCase(),
    agent,
    message,
  };
}
