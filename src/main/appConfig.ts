import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';

/**
 * Small JSON file in userData holding the handful of settings that must be
 * readable *before* the database opens -- chiefly where the database and media
 * library actually live. Everything else belongs in the database itself.
 */
interface AppConfig {
  dbPath?: string;
  mediaPath?: string;
}

function getConfigPath(): string {
  return path.join(app.getPath('userData'), 'app-config.json');
}

export function readConfig(): AppConfig {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return {};
  }
}

export function writeConfig(config: AppConfig): void {
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

export function patchConfig(patch: Partial<AppConfig>): void {
  writeConfig({ ...readConfig(), ...patch });
}
