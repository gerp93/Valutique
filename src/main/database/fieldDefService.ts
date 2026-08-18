import { Database } from 'sql.js';
import { v4 as uuidv4 } from 'uuid';
import { CreateFieldDefInput, FieldDef, UpdateFieldDefInput } from '../../shared/types/fieldDef';
import { all, one, reqStr, str, reqNum, bool, flag, json, now, buildUpdate, Row } from './helpers';
import { saveDatabase } from './schema';

function toFieldDef(row: Row): FieldDef {
  return {
    id: reqStr(row.id),
    collectionId: reqStr(row.collection_id),
    key: reqStr(row.key),
    label: reqStr(row.label),
    dataType: reqStr(row.data_type, 'text') as FieldDef['dataType'],
    options: json<string[]>(row.options_json, []),
    required: bool(row.required),
    sortOrder: reqNum(row.sort_order),
    aiExtractable: bool(row.ai_extractable),
    aiHint: str(row.ai_hint),
    showInList: bool(row.show_in_list),
    createdAt: reqStr(row.created_at),
  };
}

const SELECT = `
  id, collection_id, key, label, data_type, options_json, required, sort_order,
  ai_extractable, ai_hint, show_in_list, created_at
  FROM field_defs
`;

/**
 * Turns a human label into a stable machine key. The key becomes a JSON schema
 * property name in the AI prompt, so it has to be a plain identifier.
 */
export function slugifyKey(label: string): string {
  const base = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  // A key must not start with a digit, and must not be empty.
  if (!base) return 'field';
  return /^[0-9]/.test(base) ? `f_${base}` : base;
}

export class FieldDefService {
  constructor(private db: Database) {}

  getForCollection(collectionId: string): FieldDef[] {
    return all(this.db, `SELECT ${SELECT} WHERE collection_id = ? ORDER BY sort_order, label COLLATE NOCASE`, [
      collectionId,
    ]).map(toFieldDef);
  }

  getById(id: string): FieldDef | null {
    const row = one(this.db, `SELECT ${SELECT} WHERE id = ?`, [id]);
    return row ? toFieldDef(row) : null;
  }

  /** Ensures a proposed key doesn't collide within the collection, suffixing if it does. */
  private uniqueKey(collectionId: string, desired: string): string {
    let key = slugifyKey(desired);
    let suffix = 2;
    while (one(this.db, `SELECT id FROM field_defs WHERE collection_id = ? AND key = ?`, [collectionId, key])) {
      key = `${slugifyKey(desired)}_${suffix}`;
      suffix += 1;
    }
    return key;
  }

  create(input: CreateFieldDefInput): FieldDef {
    const id = uuidv4();
    const key = this.uniqueKey(input.collectionId, input.key || input.label);

    const nextOrder =
      input.sortOrder ??
      reqNum(
        one(this.db, `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM field_defs WHERE collection_id = ?`, [
          input.collectionId,
        ])?.next
      );

    this.db.run(
      `INSERT INTO field_defs
         (id, collection_id, key, label, data_type, options_json, required, sort_order,
          ai_extractable, ai_hint, show_in_list, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.collectionId,
        key,
        input.label,
        input.dataType,
        JSON.stringify(input.options ?? []),
        flag(input.required),
        nextOrder,
        flag(input.aiExtractable ?? true),
        input.aiHint ?? null,
        flag(input.showInList),
        now(),
      ]
    );

    saveDatabase(this.db);
    return this.getById(id)!;
  }

  createMany(inputs: CreateFieldDefInput[]): FieldDef[] {
    return inputs.map((input) => this.create(input));
  }

  update(id: string, input: UpdateFieldDefInput): FieldDef {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Field ${id} not found`);

    const update = buildUpdate({
      label: input.label,
      data_type: input.dataType,
      options_json: input.options === undefined ? undefined : JSON.stringify(input.options),
      required: input.required === undefined ? undefined : flag(input.required),
      sort_order: input.sortOrder,
      ai_extractable: input.aiExtractable === undefined ? undefined : flag(input.aiExtractable),
      ai_hint: input.aiHint === undefined ? undefined : input.aiHint,
      show_in_list: input.showInList === undefined ? undefined : flag(input.showInList),
    });

    if (update) {
      this.db.run(`UPDATE field_defs SET ${update.clause} WHERE id = ?`, [...update.params, id]);
      saveDatabase(this.db);
    }

    return this.getById(id)!;
  }

  /** Also drops every stored value for the field, via the foreign key cascade. */
  delete(id: string): void {
    this.db.run(`DELETE FROM field_defs WHERE id = ?`, [id]);
    saveDatabase(this.db);
  }

  reorder(collectionId: string, orderedIds: string[]): FieldDef[] {
    orderedIds.forEach((id, index) => {
      this.db.run(`UPDATE field_defs SET sort_order = ? WHERE id = ? AND collection_id = ?`, [
        index,
        id,
        collectionId,
      ]);
    });
    saveDatabase(this.db);
    return this.getForCollection(collectionId);
  }
}
