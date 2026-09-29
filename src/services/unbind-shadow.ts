/**
 * Preview of an unbind signature. An empty unbind is 401.
 * The message names the wallet and the agent. This module inserts nothing
 * and removes nothing. applied stays false.
 */

export interface UnbindPreview {
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

export function previewUnbind(body: unknown): UnbindPreview {
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
    'HyperDAG — unbind agent from human',
    '',
    `wallet: ${wallet.toLowerCase()}`,
    `agent:  ${agent}`,
    'scope:  release',
    '',
    'Signing this names the wallet and the agent. It does not remove a row.',
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
