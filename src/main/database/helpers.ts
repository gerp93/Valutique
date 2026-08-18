import { Database, SqlValue } from 'sql.js';

/**
 * Thin query helpers over sql.js.
 *
 * sql.js hands back columns and values as parallel arrays and requires callers
 * to free statements by hand; every service in this app wants plain objects
 * instead. Centralising that here keeps the services readable and makes sure
 * statements are always freed, including on the error path.
 */

export type Row = Record<string, SqlValue>;

export function all(db: Database, sql: string, params: SqlValue[] = []): Row[] {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const rows: Row[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    return rows;
  } finally {
    stmt.free();
  }
}

export function one(db: Database, sql: string, params: SqlValue[] = []): Row | null {
  const rows = all(db, sql, params);
  return rows.length > 0 ? rows[0] : null;
}

export function scalar(db: Database, sql: string, params: SqlValue[] = []): SqlValue | null {
  const row = one(db, sql, params);
  if (!row) return null;
  const keys = Object.keys(row);
  return keys.length > 0 ? row[keys[0]] : null;
}

export function count(db: Database, sql: string, params: SqlValue[] = []): number {
  return num(scalar(db, sql, params)) ?? 0;
}

// --- column coercion -------------------------------------------------------
// SQLite has no boolean and sql.js widens everything to SqlValue, so each read
// goes through an explicit coercion rather than a cast.

export function str(value: SqlValue | undefined): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

export function reqStr(value: SqlValue | undefined, fallback = ''): string {
  return str(value) ?? fallback;
}

export function num(value: SqlValue | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

export function reqNum(value: SqlValue | undefined, fallback = 0): number {
  return num(value) ?? fallback;
}

export function bool(value: SqlValue | undefined): boolean {
  return value === 1 || value === '1';
}

export function json<T>(value: SqlValue | undefined, fallback: T): T {
  const text = str(value);
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** SQLite has no boolean type; store 1/0 so `bool()` reads it back correctly. */
export const flag = (value: boolean | undefined | null): number => (value ? 1 : 0);

export const now = (): string => new Date().toISOString();

/**
 * Builds the SET clause for a partial update, skipping keys the caller left
 * undefined. Returns null when there is nothing to update, so callers can
 * short-circuit instead of issuing `SET updated_at = ?` on its own.
 */
export function buildUpdate(
  columns: Record<string, SqlValue | undefined>
): { clause: string; params: SqlValue[] } | null {
  const parts: string[] = [];
  const params: SqlValue[] = [];

  for (const [column, value] of Object.entries(columns)) {
    if (value === undefined) continue;
    parts.push(`${column} = ?`);
    params.push(value);
  }

  if (parts.length === 0) return null;
  return { clause: parts.join(', '), params };
}
