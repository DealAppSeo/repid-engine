// TODO(Phase 2.4): This stub is a no-op. When ZKP Cards activate, replace with
// the real Provenance Framework v1.0 implementation matching
// trinity-symphony-shared/lib/provenance.ts. See PROVENANCE_FRAMEWORK_v1.md.
export function inheritProvenance(parentMetadata: any, source: string) {
  return {
    ...parentMetadata,
    _provenance_source: source
  };
}
