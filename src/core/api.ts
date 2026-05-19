import type { AppSettings } from '../shared/types';

export async function callForScript(settings: AppSettings, prompt: string): Promise<string> {
  return settings.apiProvider === 'openai'
    ? callOpenAi(settings, prompt)
    : callAnthropic(settings, prompt);
}

async function callAnthropic(settings: AppSettings, prompt: string): Promise<string> {
  const res = await fetch(`${settings.apiBaseUrl || 'https://api.anthropic.com'}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': settings.apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: settings.model || 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!res.ok) throw new Error(`Anthropic API returned ${res.status}: ${await res.text()}`);
  const data = await res.json() as { content?: Array<{ type?: string; text?: string }> };
  return data.content?.find((part) => part.type === 'text')?.text ?? '';
}

async function callOpenAi(settings: AppSettings, prompt: string): Promise<string> {
  const res = await fetch(`${settings.apiBaseUrl || 'https://api.openai.com/v1'}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      model: settings.model || 'gpt-4.1-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0
    })
  });
  if (!res.ok) throw new Error(`OpenAI API returned ${res.status}: ${await res.text()}`);
  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? '';
}
