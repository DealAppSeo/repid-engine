/**
 * A7 — giveFeedback from a non-writer is refused at the engine. SYNTHETIC.
 */
import {
  assertFeedbackWriterAllowed,
  NonWriterError,
  parseWriterAllowlist,
} from '../src/services/erc8004-writer-allowlist';

const WRITER = '0xb242688800000000000000000000000000000000';
const STRANGER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('writer allowlist', () => {
  it('parses a comma-separated config list', () => {
    expect(parseWriterAllowlist(`${WRITER}, ${STRANGER}`)).toEqual([WRITER, STRANGER]);
  });

  it('refuses a non-writer when an allowlist is configured', () => {
    expect(() => assertFeedbackWriterAllowed(STRANGER, [WRITER])).toThrow(NonWriterError);
  });

  it('an empty allowlist does not halt the engine signer (the key IS the writer)', () => {
    expect(() => assertFeedbackWriterAllowed(WRITER, [])).not.toThrow();
  });

  it('allows a configured writer', () => {
    expect(() => assertFeedbackWriterAllowed(WRITER, [WRITER])).not.toThrow();
  });
});
