import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import { readConfig, patchConfig, writeConfig } from './appConfig';

/**
 * A library is a folder, not a file:
 *
 *   <library>/
 *     library.json     { "format": 1 }
 *     valutique.db
 *     media/           content-addressed photo blobs
 *
 * The database stores photos as paths relative to `media/`, so the two are one
 * thing. Earlier versions let them be pointed at separately, which meant any
 * move of the database silently orphaned every photo -- the collection opened
 * normally and the images were simply gone. Naming the folder rather than the
 * .db file makes that state unreachable: there is one path to configure, and
 * moving it moves everything.
 */

export const DB_FILENAME = 'valutique.db';
export const MEDIA_DIRNAME = 'media';
export const MARKER_FILENAME = 'library.json';
export const LIBRARY_FORMAT = 1;

/** Raised for a layout problem the user has to resolve; fatal, and shown verbatim at startup. */
export class LibraryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LibraryError';
  }
}

export function getDefaultLibraryPath(): string {
  return app.getPath('userData');
}

export function getEffectiveLibraryPath(): string {
  const configured = readConfig().libraryPath;
  return configured && configured.trim() !== '' ? configured : getDefaultLibraryPath();
}

export function isUsingDefaultLibrary(): boolean {
  return !readConfig().libraryPath;
}

export function getDbPath(libraryPath: string = getEffectiveLibraryPath()): string {
  return path.join(libraryPath, DB_FILENAME);
}

export function getMediaPath(libraryPath: string = getEffectiveLibraryPath()): string {
  return path.join(libraryPath, MEDIA_DIRNAME);
}

/** Kept under the old name so callers reading "the database path" still read naturally. */
export function getEffectiveDbPath(): string {
  return getDbPath();
}

export function writeMarker(libraryPath: string): void {
  fs.mkdirSync(libraryPath, { recursive: true });
  fs.writeFileSync(
    path.join(libraryPath, MARKER_FILENAME),
    JSON.stringify({ format: LIBRARY_FORMAT }, null, 2)
  );
}

export type FolderKind =
  /** Already a library: has a marker or a database. */
  | 'library'
  /** Nothing there, or nothing that matters -- safe to make into one. */
  | 'empty'
  /** Holds unrelated files. Claiming it would scatter media/ and format files through someone else's folder. */
  | 'occupied';

export function inspectFolder(target: string): { kind: FolderKind; detail: string } {
  if (!fs.existsSync(target)) return { kind: 'empty', detail: 'A new folder will be created.' };

  let entries: string[];
  try {
    entries = fs.readdirSync(target);
  } catch (err) {
    throw new LibraryError(`That folder could not be read:\n\n${target}\n\n${(err as Error).message}`);
  }

  const visible = entries.filter((name) => !name.startsWith('.'));
  if (visible.includes(MARKER_FILENAME) || visible.includes(DB_FILENAME)) {
    return { kind: 'library', detail: 'An existing Valutique library.' };
  }
  if (visible.length === 0) return { kind: 'empty', detail: 'An empty folder.' };

  return {
    kind: 'occupied',
    detail:
      `That folder already holds ${visible.length} other ${visible.length === 1 ? 'item' : 'items'}. ` +
      `Valutique would add its database, a media folder and its own settings file alongside them. ` +
      `Choose an empty folder, or make a new one inside this one just for Valutique.`,
  };
}

/**
 * Points the app at another library.
 *
 * An existing library is adopted exactly as it stands. An empty target gets a
 * copy of the current one -- copy rather than move, so a failure part-way
 * through leaves the original intact and the user loses nothing.
 */
export function setLibraryPath(newPath: string): void {
  const current = getEffectiveLibraryPath();
  if (path.resolve(current) === path.resolve(newPath)) return;

  const { kind, detail } = inspectFolder(newPath);
  if (kind === 'occupied') throw new LibraryError(detail);

  if (kind === 'empty') {
    fs.mkdirSync(newPath, { recursive: true });
    copyLibraryContents(current, newPath);
    writeMarker(newPath);
  }

  patchConfig({ libraryPath: newPath });
}

export function resetToDefaultLibrary(): void {
  const config = readConfig();
  delete config.libraryPath;
  writeConfig(config);
}

/**
 * Brings a pre-library install up to date.
 *
 * Runs before the database opens, because it decides where the database is.
 * Throws rather than guessing: an ambiguous layout resolved by picking one of
 * two candidate files is exactly the silent substitution this app removed in
 * 0.0.4, and it would be resolved against the user's real collection.
 */
export function migrateLegacyLayout(): void {
  const config = readConfig();

  if (config.libraryPath) {
    ensureMarker(config.libraryPath);
    dropLegacyKeys();
    return;
  }

  // The default install is already shaped like a library -- the database and
  // media/ sit together in userData -- so it needs a marker and nothing else.
  if (!config.dbPath) {
    ensureMarker(getDefaultLibraryPath());
    adoptStrayMedia(getDefaultLibraryPath());
    dropLegacyKeys();
    return;
  }

  const libraryPath = path.dirname(config.dbPath);
  const currentName = path.basename(config.dbPath);
  const canonical = path.join(libraryPath, DB_FILENAME);

  if (currentName !== DB_FILENAME) {
    if (fs.existsSync(canonical)) {
      throw new LibraryError(
        `Valutique cannot tell which of these is your collection:\n\n` +
          `  ${config.dbPath}\n  ${canonical}\n\n` +
          `Both sit in the folder that is now your library, which expects a single ${DB_FILENAME}. ` +
          `Rename or move the one you do not want and start Valutique again. Nothing has been changed.`
      );
    }
    if (fs.existsSync(config.dbPath)) {
      fs.renameSync(config.dbPath, canonical);
      console.log(`Database renamed into the library layout: ${config.dbPath} -> ${canonical}`);
    }
  }

  adoptStrayMedia(libraryPath);
  ensureMarker(libraryPath);
  patchConfig({ libraryPath });
  dropLegacyKeys();
  console.log(`Library folder adopted: ${libraryPath}`);
}

/**
 * Pulls a photo library that was left elsewhere into the library folder. Two
 * ways it got separated: an explicitly configured mediaPath from when that was
 * settable, and a database that moved while its photos stayed in userData.
 */
function adoptStrayMedia(libraryPath: string): void {
  const desired = getMediaPath(libraryPath);
  if (hasAnyFile(desired)) return;

  const candidates = [readConfig().mediaPath, path.join(getDefaultLibraryPath(), MEDIA_DIRNAME)];

  for (const legacy of candidates) {
    if (!legacy || legacy.trim() === '') continue;
    if (path.resolve(legacy) === path.resolve(desired)) continue;
    if (!hasAnyFile(legacy)) continue;

    fs.mkdirSync(desired, { recursive: true });
    copyDirectory(legacy, desired);
    console.log(`Photo library moved into the library folder: ${legacy} -> ${desired}`);
    return;
  }
}

function ensureMarker(libraryPath: string): void {
  if (!fs.existsSync(path.join(libraryPath, MARKER_FILENAME))) writeMarker(libraryPath);
}

function dropLegacyKeys(): void {
  const config = readConfig();
  if (config.dbPath === undefined && config.mediaPath === undefined) return;
  delete config.dbPath;
  delete config.mediaPath;
  writeConfig(config);
}

function copyLibraryContents(from: string, to: string): void {
  const db = path.join(from, DB_FILENAME);
  if (fs.existsSync(db)) fs.copyFileSync(db, path.join(to, DB_FILENAME));

  const media = path.join(from, MEDIA_DIRNAME);
  if (fs.existsSync(media)) {
    fs.mkdirSync(path.join(to, MEDIA_DIRNAME), { recursive: true });
    copyDirectory(media, path.join(to, MEDIA_DIRNAME));
  }
}

function copyDirectory(from: string, to: string): void {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      copyDirectory(src, dest);
    } else if (!fs.existsSync(dest)) {
      fs.copyFileSync(src, dest);
    }
  }
}

function hasAnyFile(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (hasAnyFile(path.join(dir, entry.name))) return true;
    } else {
      return true;
    }
  }
  return false;
}

/** Photo count and bytes on disk, for the Settings summary. */
export function libraryStats(libraryPath: string = getEffectiveLibraryPath()): {
  photoCount: number;
  photoBytes: number;
  dbBytes: number;
} {
  let photoCount = 0;
  let photoBytes = 0;

  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        photoCount += 1;
        photoBytes += fs.statSync(full).size;
      }
    }
  };
  walk(getMediaPath(libraryPath));

  let dbBytes = 0;
  try {
    dbBytes = fs.statSync(getDbPath(libraryPath)).size;
  } catch {
    // A library whose database has not been written yet reports zero.
  }

  return { photoCount, photoBytes, dbBytes };
}
