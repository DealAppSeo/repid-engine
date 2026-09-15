/**
 * erc8004-writer-allowlist.ts — engine-side A7 control.
 *
 * ERC-8004 giveFeedback is permissionless on the contract. The engine must still
 * refuse to SIGN a write from a wallet that is not on the configured writer
 * list. Unknown signers are refused, never silently used.
 *
 * Config: ERC8004_FEEDBACK_WRITERS (comma-separated). Empty list means the
 * engine's signing key is the writer (do not halt every on-chain write). A
 * non-empty list refuses anyone not on it. Tests inject the list.
 */
export class NonWriterError extends Error {
  constructor(public readonly address: string) {
    super(`giveFeedback refused: signer ${address} is not an allowed writer`);
    this.name = 'NonWriterError';
  }
}

function norm(a: string): string {
  return a.trim().toLowerCase();
}

export function parseWriterAllowlist(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => norm(s))
    .filter((s) => /^0x[0-9a-f]{40}$/.test(s));
}

export function writerAllowlistFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const fromList = parseWriterAllowlist(env.ERC8004_FEEDBACK_WRITERS);
  const extra = [
    env.ERC8004_REPUTATION_WRITER_ADDRESS,
    env.ERC8004_OPERATOR_ADDRESS,
  ]
    .filter((x): x is string => !!x)
    .map(norm)
    .filter((s) => /^0x[0-9a-f]{40}$/.test(s));
  return Array.from(new Set([...fromList, ...extra]));
}

export function assertFeedbackWriterAllowed(
  signer: string,
  allowlist: string[] = writerAllowlistFromEnv(),
): void {
  const addr = norm(signer);
  if (!/^0x[0-9a-f]{40}$/.test(addr)) {
    throw new NonWriterError(signer);
  }
  // Empty list: the engine's configured signing key IS the writer. A7 tests
  // pass an explicit list. A missing config must not halt every on-chain write.
  if (allowlist.length === 0) return;
  if (!allowlist.includes(addr)) {
    throw new NonWriterError(signer);
  }
}
