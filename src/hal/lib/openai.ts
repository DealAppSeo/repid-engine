// Minimal OpenAI chat helper. Originally authored by GA (HAL precision-grounding sprint, 2026-06-11)
// as the NLI backend for evidence-grounding; folded in here for the DEMOTED support-only grounding
// hook (see fact-check.ts `checkEntailment`). Throws if OPENAI_API_KEY is unset — callers must catch.
export async function queryOpenAI(prompt: string, systemPrompt: string, jsonMode = false): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set');
  }
  const endpoint = 'https://api.openai.com/v1/chat/completions';
  const body: any = {
    model: process.env.HAL_GROUNDING_MODEL ?? 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ],
    temperature: 0,
  };
  if (jsonMode) {
    body.response_format = { type: 'json_object' };
  }
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI HTTP ${res.status}: ${text}`);
  }
  const data = (await res.json()) as any;
  return data?.choices?.[0]?.message?.content ?? '';
}
