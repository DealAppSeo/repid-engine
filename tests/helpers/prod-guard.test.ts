import {
  PRODUCTION_SUPABASE_REF,
  supabaseRefFromUrl,
  isProductionSupabase,
  assertNotProductionSupabase,
} from './prod-guard';

describe('prod-guard', () => {
  it('derives the project ref from a supabase URL', () => {
    expect(supabaseRefFromUrl('https://qnnpjhlxljtqyigedwkb.supabase.co')).toBe(
      PRODUCTION_SUPABASE_REF,
    );
    expect(supabaseRefFromUrl('https://testproj123.supabase.co/rest/v1')).toBe(
      'testproj123',
    );
  });

  it('returns empty string for missing / non-supabase URLs', () => {
    expect(supabaseRefFromUrl(undefined)).toBe('');
    expect(supabaseRefFromUrl('')).toBe('');
    expect(supabaseRefFromUrl('http://localhost:54321')).toBe('');
  });

  it('flags the production project and only the production project', () => {
    expect(isProductionSupabase(`https://${PRODUCTION_SUPABASE_REF}.supabase.co`)).toBe(true);
    expect(isProductionSupabase('https://some-test-project.supabase.co')).toBe(false);
    expect(isProductionSupabase(undefined)).toBe(false);
  });

  it('assertNotProductionSupabase throws on prod, passes on a test project', () => {
    expect(() =>
      assertNotProductionSupabase(`https://${PRODUCTION_SUPABASE_REF}.supabase.co`),
    ).toThrow(/refusing to run/i);
    expect(() =>
      assertNotProductionSupabase('https://test-project.supabase.co'),
    ).not.toThrow();
    // Passing an explicit URL of undefined means "no project" -> not prod.
    // Clear the env first: assertNotProductionSupabase defaults its arg to
    // process.env.SUPABASE_URL, so an explicit `undefined` would otherwise
    // resolve to whatever SUPABASE_URL the runner has set (prod in CI).
    const prevUrl = process.env.SUPABASE_URL;
    delete process.env.SUPABASE_URL;
    try {
      expect(() => assertNotProductionSupabase(undefined)).not.toThrow();
    } finally {
      if (prevUrl === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = prevUrl;
    }
  });
});
