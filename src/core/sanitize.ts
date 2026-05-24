const SENSITIVE_HINTS = [
  'password',
  'passwd',
  'pwd',
  'token',
  'api-key',
  'apikey',
  'authorization',
  'cookie',
  'secret',
  'bearer',
  'wrong_password'
];

const FAKE_CARD = '4111111111111111';

export function isSensitiveHint(hint: string | undefined): boolean {
  if (!hint) return false;
  const normalized = hint.toLowerCase();
  return SENSITIVE_HINTS.some((item) => normalized.includes(item));
}

export function redactSensitiveText(value: string, hint?: string): string {
  if (!value) return value;
  if (isSensitiveHint(hint) || value === 'wrong_password') return '[REDACTED]';

  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(api[-_ ]?key["':=\s]+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/(authorization["':=\s]+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/(password["':=\s]+)[^,\s"}]+/gi, '$1[REDACTED]')
    .replace(/wrong_password/g, '[REDACTED]')
    .replace(new RegExp(FAKE_CARD, 'g'), '[FAKE_CARD_REDACTED]');
}

export function redactValue<T>(value: T, hint?: string): T {
  if (typeof value === 'string') {
    return redactSensitiveText(value, hint) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, hint)) as T;
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const nextHint = `${hint || ''} ${key}`;
      output[key] = redactValue(item, nextHint);
    }
    return output as T;
  }
  return value;
}

