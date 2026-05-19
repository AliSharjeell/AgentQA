import fs from 'node:fs';
import path from 'node:path';
import type { AppSettings } from '../shared/types';

const DEFAULT_DIR = path.join(process.env.APPDATA || process.env.HOME || '.', 'agentqa');

export function loadSettings(baseDir?: string): AppSettings {
  const dir = baseDir || DEFAULT_DIR;
  const filePath = path.join(dir, 'settings.json');
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8')) as AppSettings;
    }
  } catch { /* ignore */ }
  return {
    apiProvider: 'anthropic',
    apiKey: '',
    apiBaseUrl: '',
    model: 'claude-sonnet-4-20250514'
  };
}

export function saveSettings(settings: AppSettings, baseDir?: string): void {
  const dir = baseDir || DEFAULT_DIR;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');
}
