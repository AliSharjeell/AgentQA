import type { AppSettings, ProviderRetryEvent } from '../shared/types';

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  backoffMultiplier: number;
  maxDelayMs: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 4,
  baseDelayMs: 1000,
  backoffMultiplier: 2,
  maxDelayMs: 30000
};

const TRANSIENT_STATUS_CODES = new Set([429, 500, 501, 502, 503, 504, 529]);
const TRANSIENT_ERROR_TYPES = new Set([
  'overloaded_error',
  'rate_limit_error',
  'timeout',
  'connection_error',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED'
]);

export async function callForScript(
  settings: AppSettings,
  prompt: string,
  options?: {
    phase?: string;
    onRetry?: (event: ProviderRetryEvent) => void;
    retryConfig?: Partial<RetryConfig>;
  }
): Promise<string> {
  return settings.apiProvider === 'openai'
    ? callOpenAi(settings, prompt, options)
    : callAnthropic(settings, prompt, options);
}

function jitter(delayMs: number): number {
  return Math.floor(delayMs * (0.5 + Math.random()));
}

function isTransientError(status: number, errorType: string | undefined): boolean {
  if (TRANSIENT_STATUS_CODES.has(status)) return true;
  if (errorType && TRANSIENT_ERROR_TYPES.has(errorType)) return true;
  return false;
}

async function callAnthropic(
  settings: AppSettings,
  prompt: string,
  options?: {
    phase?: string;
    onRetry?: (event: ProviderRetryEvent) => void;
    retryConfig?: Partial<RetryConfig>;
  }
): Promise<string> {
  const config = { ...DEFAULT_RETRY_CONFIG, ...options?.retryConfig };
  const baseUrl = settings.apiBaseUrl || 'https://api.anthropic.com';
  const model = settings.model || 'claude-sonnet-4-20250514';
  let lastError: string = '';

  for (let attempt = 1; attempt <= config.maxRetries + 1; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);

    try {
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': settings.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          messages: [{ role: 'user', content: prompt }]
        }),
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (res.ok) {
        const data = await res.json() as { content?: Array<{ type?: string; text?: string }> };
        return data.content?.find((part) => part.type === 'text')?.text ?? '';
      }

      const status = res.status;
      let errorType = '';
      let retryAfterMs = 0;

      try {
        const errorBody = JSON.parse(await res.text()) as { error?: { type?: string; message?: string } };
        errorType = errorBody.error?.type || '';
        retryAfterMs = res.headers.get('retry-after') ? parseInt(res.headers.get('retry-after')!, 10) * 1000 : 0;
        lastError = errorBody.error?.message || `HTTP ${status}`;
      } catch {
        lastError = `HTTP ${status}`;
      }

      const event: ProviderRetryEvent = {
        timestamp: new Date().toISOString(),
        provider: 'anthropic',
        model,
        phase: options?.phase || 'planning',
        attempt,
        status,
        type: errorType || `HTTP_${status}`,
        recovered: false,
        retryAfterMs
      };

      if (attempt <= config.maxRetries && isTransientError(status, errorType)) {
        const delay = retryAfterMs > 0 ? retryAfterMs : jitter(config.baseDelayMs * Math.pow(config.backoffMultiplier, attempt - 1));
        const cappedDelay = Math.min(delay, config.maxDelayMs);
        event.recovered = false;
        event.error = lastError;
        options?.onRetry?.(event);

        await sleep(cappedDelay);
        continue;
      }

      throw Object.assign(new Error(`Anthropic API returned ${status}: ${lastError}`), { providerEvent: event });
    } catch (err: unknown) {
      clearTimeout(timeout);
      if (err instanceof Error && 'providerEvent' in err) throw err;
      const errorMessage = err instanceof Error ? err.message : String(err);
      const isAbort = errorMessage.includes('aborted') || errorMessage.includes('The user aborted');

      if (attempt <= config.maxRetries && (isAbort || isTransientError(0, errorMessage))) {
        const delay = jitter(config.baseDelayMs * Math.pow(config.backoffMultiplier, attempt - 1));
        const cappedDelay = Math.min(delay, config.maxDelayMs);
        const event: ProviderRetryEvent = {
          timestamp: new Date().toISOString(),
          provider: 'anthropic',
          model,
          phase: options?.phase || 'planning',
          attempt,
          status: 0,
          type: isAbort ? 'timeout' : errorMessage.split(':')[0],
          recovered: false,
          retryAfterMs: cappedDelay,
          error: errorMessage
        };
        options?.onRetry?.(event);
        await sleep(cappedDelay);
        continue;
      }
      throw err;
    }
  }

  throw new Error(`Anthropic API failed after ${config.maxRetries + 1} attempts: ${lastError}`);
}

async function callOpenAi(
  settings: AppSettings,
  prompt: string,
  options?: {
    phase?: string;
    onRetry?: (event: ProviderRetryEvent) => void;
    retryConfig?: Partial<RetryConfig>;
  }
): Promise<string> {
  const config = { ...DEFAULT_RETRY_CONFIG, ...options?.retryConfig };
  const baseUrl = settings.apiBaseUrl || 'https://api.openai.com/v1';
  const model = settings.model || 'gpt-4.1-mini';
  let lastError: string = '';

  for (let attempt = 1; attempt <= config.maxRetries + 1; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);

    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${settings.apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0
        }),
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (res.ok) {
        const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
        return data.choices?.[0]?.message?.content ?? '';
      }

      const status = res.status;
      let errorType = '';
      let retryAfterMs = 0;

      try {
        const errorBody = JSON.parse(await res.text()) as { error?: { type?: string; message?: string; code?: string } };
        errorType = errorBody.error?.type || errorBody.error?.code || '';
        retryAfterMs = res.headers.get('retry-after') ? parseInt(res.headers.get('retry-after')!, 10) * 1000 : 0;
        lastError = errorBody.error?.message || `HTTP ${status}`;
      } catch {
        lastError = `HTTP ${status}`;
      }

      const event: ProviderRetryEvent = {
        timestamp: new Date().toISOString(),
        provider: 'openai',
        model,
        phase: options?.phase || 'planning',
        attempt,
        status,
        type: errorType || `HTTP_${status}`,
        recovered: false,
        retryAfterMs
      };

      if (attempt <= config.maxRetries && isTransientError(status, errorType)) {
        const delay = retryAfterMs > 0 ? retryAfterMs : jitter(config.baseDelayMs * Math.pow(config.backoffMultiplier, attempt - 1));
        const cappedDelay = Math.min(delay, config.maxDelayMs);
        event.recovered = false;
        event.error = lastError;
        options?.onRetry?.(event);

        await sleep(cappedDelay);
        continue;
      }

      throw Object.assign(new Error(`OpenAI API returned ${status}: ${lastError}`), { providerEvent: event });
    } catch (err: unknown) {
      clearTimeout(timeout);
      if (err instanceof Error && 'providerEvent' in err) throw err;
      const errorMessage = err instanceof Error ? err.message : String(err);
      const isAbort = errorMessage.includes('aborted') || errorMessage.includes('The user aborted');

      if (attempt <= config.maxRetries && (isAbort || isTransientError(0, errorMessage))) {
        const delay = jitter(config.baseDelayMs * Math.pow(config.backoffMultiplier, attempt - 1));
        const cappedDelay = Math.min(delay, config.maxDelayMs);
        const event: ProviderRetryEvent = {
          timestamp: new Date().toISOString(),
          provider: 'openai',
          model,
          phase: options?.phase || 'planning',
          attempt,
          status: 0,
          type: isAbort ? 'timeout' : errorMessage.split(':')[0],
          recovered: false,
          retryAfterMs: cappedDelay,
          error: errorMessage
        };
        options?.onRetry?.(event);
        await sleep(cappedDelay);
        continue;
      }
      throw err;
    }
  }

  throw new Error(`OpenAI API failed after ${config.maxRetries + 1} attempts: ${lastError}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
