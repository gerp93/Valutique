import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import { readConfig, patchConfig, writeConfig } from './appConfig';

export function getDefaultDbPath(): string {
  return path.join(app.getPath('userData'), 'valutique.db');
}

/** The database file the app will actually load on startup: a user-chosen location, or the default. */
export function getEffectiveDbPath(): string {
  const configured = readConfig().dbPath;
  return configured && configured.trim() !== '' ? configured : getDefaultDbPath();
}

export function isUsingDefaultLocation(): boolean {
  return !readConfig().dbPath;
}

/**
 * Point the app at a different SQLite file. If nothing exists yet at the new
 * location, the current database is copied there first so no data is lost.
 * If a file already exists there, it's left alone and simply adopted as-is.
 */
export function setDbPath(newPath: string): void {
  const currentPath = getEffectiveDbPath();

  if (!fs.existsSync(newPath) && fs.existsSync(currentPath)) {
    fs.mkdirSync(path.dirname(newPath), { recursive: true });
    fs.copyFileSync(currentPath, newPath);
  }

  patchConfig({ dbPath: newPath });
}

export function resetToDefaultDbPath(): void {
  const config = readConfig();
  delete config.dbPath;
  writeConfig(config);
}
