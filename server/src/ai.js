const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

export const aiEnabled = () => Boolean(process.env.OPENAI_API_KEY);

/**
 * Optional recipe generation. The server validates and persists the generated
 * recipes; callers should use the curated offline suggestions when this fails.
 */
export async function suggestRecipes(inventory) {
  if (!aiEnabled()) throw new Error('OPENAI_API_KEY is not configured.');

  const response = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      temperature: 0.6,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'Create up to four practical Filipino home-cooking recipe suggestions anchored on ingredients actually in the refrigerator. Return JSON only as {"recipes":[{"name":"...","anchor":"exact inventory item name","emoji":"...","time":"...","servings":4,"ingredients":[{"key":"...","amount":"..."}],"steps":["..."]}]}. The first ingredient must be the anchor ingredient. Include clear ordered cooking steps and safe internal temperatures for meat. Do not claim missing ingredients are in stock.',
        },
        {
          role: 'user',
          content: `Available refrigerator inventory (JSON): ${JSON.stringify(inventory)}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Recipe AI request failed (${response.status}): ${detail.slice(0, 300)}`);
  }

  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error('Recipe AI returned an empty response.');

  const result = JSON.parse(content);
  if (!Array.isArray(result.recipes)) throw new Error('Recipe AI response has no recipes list.');
  return result;
}
