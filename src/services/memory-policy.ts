/**
 * Public memory policy. A fixed record. This module does not read or write a database.
 */
export interface MemoryPolicy {
  stores_prompts: false;
  vendors_see: 'redacted_only';
  local_canonical: true;
}

export function memoryPolicy(): MemoryPolicy {
  return {
    stores_prompts: false,
    vendors_see: 'redacted_only',
    local_canonical: true,
  };
}
