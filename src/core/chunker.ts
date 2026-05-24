export function splitSafe(text: string, maxLen: number): string[] {
  if (maxLen <= 0) throw new Error('splitSafe maxLen must be greater than 0.');
  if (text.length <= maxLen) return [text];

  let chunks = [text];
  for (const separator of ['\n\n', '\n', '. ', ' ', '']) {
    const next: string[] = [];
    for (const chunk of chunks) {
      if (chunk.length <= maxLen) {
        next.push(chunk);
        continue;
      }
      if (separator === '') {
        for (let i = 0; i < chunk.length; i += maxLen) {
          next.push(chunk.slice(i, i + maxLen));
        }
        continue;
      }
      splitBySeparator(chunk, separator, maxLen, next);
    }
    chunks = next;
    if (chunks.every((chunk) => chunk.length <= maxLen)) return chunks;
  }

  return chunks;
}

function splitBySeparator(text: string, separator: string, maxLen: number, output: string[]): void {
  const parts = text.split(separator);
  if (parts.length === 1) {
    output.push(text);
    return;
  }

  let buffer = '';
  for (const part of parts) {
    const candidate = buffer ? `${buffer}${separator}${part}` : part;
    if (candidate.length <= maxLen) {
      buffer = candidate;
      continue;
    }
    if (buffer) output.push(buffer);
    if (part.length > maxLen) {
      output.push(part);
      buffer = '';
    } else {
      buffer = part;
    }
  }
  if (buffer) output.push(buffer);
}

export function truncateText(value: string | undefined | null, maxLen: number): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 16)).trim()} ...[truncated]`;
}
