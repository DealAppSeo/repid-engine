export function inheritProvenance(parentMetadata: any, source: string) {
  return {
    ...parentMetadata,
    _provenance_source: source
  };
}
