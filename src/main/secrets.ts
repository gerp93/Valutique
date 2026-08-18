import * as path from 'path';
import * as fs from 'fs';
import { app, safeStorage } from 'electron';

/**
 * Credential vault, deliberately separate from the SQLite database.
 *
 * The database is designed to be relocated into a cloud-synced folder for
 * backup, which means anything stored in it may end up on someone else's
 * server. API keys must not ride along, so they live here: encrypted with the
 * OS keychain (DPAPI on Windows, Keychain on macOS, libsecret on Linux) in
 * userData, which is never relocated.
 *
 * Values only ever exist in plaintext inside the main process. Nothing here is
 * exposed over IPC -- the renderer can ask *whether* a key is set, never what
 * it is.
 */

interface SecretsFile {
  /** key -> base64 of the encrypted buffer, or of the plaintext when encryption is unavailable. */
  values: Record<string, string>;
  /** False on systems where safeStorage has no backing store (some Linux desktops). */
  encrypted: boolean;
}

function secretsPath(): string {
  return path.join(app.getPath('userData'), 'secrets.json');
}

function read(): SecretsFile {
  const p = secretsPath();
  if (!fs.existsSync(p)) return { values: {}, encrypted: false };
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return { values: parsed.values ?? {}, encrypted: Boolean(parsed.encrypted) };
  } catch {
    return { values: {}, encrypted: false };
  }
}

function write(file: SecretsFile): void {
  fs.writeFileSync(secretsPath(), JSON.stringify(file, null, 2), { mode: 0o600 });
}

export function isEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

export function setSecret(key: string, value: string | null): void {
  const file = read();

  if (value === null || value === '') {
    delete file.values[key];
    write(file);
    return;
  }

  if (isEncryptionAvailable()) {
    file.values[key] = safeStorage.encryptString(value).toString('base64');
    file.encrypted = true;
  } else {
    // No OS keychain available. Store it, but flag the file as unencrypted so
    // the UI can warn rather than silently implying the key is protected.
    file.values[key] = Buffer.from(value, 'utf-8').toString('base64');
    file.encrypted = false;
  }

  write(file);
}

export function getSecret(key: string): string | null {
  const file = read();
  const stored = file.values[key];
  if (!stored) return null;

  const buffer = Buffer.from(stored, 'base64');
  if (file.encrypted) {
    try {
      return safeStorage.decryptString(buffer);
    } catch {
      // Usually means the OS keychain changed underneath us (different user,
      // restored machine). Treat as missing rather than crashing the job.
      return null;
    }
  }
  return buffer.toString('utf-8');
}

export function hasSecret(key: string): boolean {
  return Boolean(read().values[key]);
}

export function deleteSecret(key: string): void {
  setSecret(key, null);
}

export const connectorKeyRef = (connectorId: string): string => `connector:${connectorId}:apiKey`;
export const EBAY_CLIENT_ID = 'ebay:clientId';
export const EBAY_CLIENT_SECRET = 'ebay:clientSecret';
