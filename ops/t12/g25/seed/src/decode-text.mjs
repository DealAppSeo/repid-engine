/** Text from a file that may be UTF-8 or UTF-16, with or without a byte-order mark. */
export function decodeText(raw) {
  if (raw[0] === 0xff && raw[1] === 0xfe) return raw.subarray(2).toString('utf16le');
  if (raw[0] === 0xfe && raw[1] === 0xff) return Buffer.from(raw.subarray(2)).swap16().toString('utf16le');
  const text = raw.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
