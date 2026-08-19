import { Database, SqlValue } from 'sql.js';
import { v4 as uuidv4 } from 'uuid';
import {
  CONDITION_GRADES,
  ConditionGrade,
  CreateItemInput,
  Item,
  ItemAiStatus,
  ItemDetail,
  ItemFieldValue,
  ItemFilter,
  ItemListEntry,
  SearchMatch,
  UpdateItemInput,
} from '../../shared/types/item';
import { FieldDef } from '../../shared/types/fieldDef';
import { all, one, reqStr, str, num, reqNum, bool, flag, json, now, buildUpdate, Row } from './helpers';
import { saveDatabase } from './schema';
import { FieldDefService } from './fieldDefService';
import { AppraisalService } from './appraisalService';
import { PhotoService } from './photoService';

function toItem(row: Row): Item {
  const grade = reqStr(row.condition_grade, 'unknown') as ConditionGrade;
  return {
    id: reqStr(row.id),
    collectionId: reqStr(row.collection_id),
    name: reqStr(row.name),
    description: str(row.description),
    notes: str(row.notes),
    aiNotes: str(row.ai_notes),
    location: str(row.location),
    conditionGrade: CONDITION_GRADES.includes(grade) ? grade : 'unknown',
    conditionNotes: str(row.condition_notes),
    quantity: reqNum(row.quantity, 1),
    acquiredDate: str(row.acquired_date),
    acquiredPrice: num(row.acquired_price),
    aiStatus: reqStr(row.ai_status, 'none') as ItemAiStatus,
    aiTier: (str(row.ai_tier) as Item['aiTier']) ?? null,
    aiLastRunAt: str(row.ai_last_run_at),
    aiError: str(row.ai_error),
    createdAt: reqStr(row.created_at),
    updatedAt: reqStr(row.updated_at),
  };
}

const ITEM_COLUMNS = `
  id, collection_id, name, description, notes, ai_notes, location, condition_grade, condition_notes,
  quantity, acquired_date, acquired_price, ai_status, ai_tier, ai_last_run_at, ai_error, created_at, updated_at
`;

/**
 * Where a search match is explained from, in the order checked. Name is
 * deliberately excluded -- it's the card's own title, already visible, so a
 * match there needs no explanation. Description comes before the notes
 * fields since it's the most likely place a casual search term lives.
 */
const SEARCH_FIELDS: { field: SearchMatch['field']; label: string; get: (item: Item) => string | null }[] = [
  { field: 'description', label: 'Description', get: (item) => item.description },
  { field: 'notes', label: 'Your notes', get: (item) => item.notes },
  { field: 'aiNotes', label: 'AI notes', get: (item) => item.aiNotes },
  { field: 'location', label: 'Location', get: (item) => item.location },
];

const SNIPPET_CONTEXT_CHARS = 42;

/** Finds the first field a search term actually matched in, with a bit of surrounding context. */
function findSearchMatch(term: string, item: Item): SearchMatch | null {
  const lowerTerm = term.toLowerCase();

  for (const { field, label, get } of SEARCH_FIELDS) {
    const text = get(item);
    if (!text) continue;

    const index = text.toLowerCase().indexOf(lowerTerm);
    if (index === -1) continue;

    const start = Math.max(0, index - SNIPPET_CONTEXT_CHARS);
    const end = Math.min(text.length, index + term.length + SNIPPET_CONTEXT_CHARS);
    const prefix = start > 0 ? '…' : '';
    const suffix = end < text.length ? '…' : '';

    return { field, label, snippet: `${prefix}${text.slice(start, end).trim()}${suffix}` };
  }

  return null;
}

/** One field value on its way into the database, keyed by definition. */
export interface FieldValueWrite {
  fieldDefId: string;
  value: unknown;
  fromAi?: boolean;
  confidence?: number | null;
}

export class ItemService {
  constructor(
    private db: Database,
    private fieldDefs: FieldDefService,
    private photos: PhotoService,
    private appraisals: AppraisalService
  ) {}

  getById(id: string): Item | null {
    const row = one(this.db, `SELECT ${ITEM_COLUMNS} FROM items WHERE id = ?`, [id]);
    return row ? toItem(row) : null;
  }

  list(filter: ItemFilter): ItemListEntry[] {
    const where: string[] = ['i.collection_id = ?'];
    const params: SqlValue[] = [filter.collectionId];

    if (filter.search) {
      where.push('(i.name LIKE ? OR i.description LIKE ? OR i.notes LIKE ? OR i.ai_notes LIKE ? OR i.location LIKE ?)');
      const like = `%${filter.search}%`;
      params.push(like, like, like, like, like);
    }
    if (filter.conditionGrade) {
      where.push('i.condition_grade = ?');
      params.push(filter.conditionGrade);
    }
    if (filter.location) {
      where.push('i.location = ?');
      params.push(filter.location);
    }
    if (filter.aiStatus) {
      where.push('i.ai_status = ?');
      params.push(filter.aiStatus);
    }
    if (filter.appraisalState === 'appraised') {
      where.push('EXISTS (SELECT 1 FROM appraisals a WHERE a.item_id = i.id AND a.is_current = 1 AND a.value_mid IS NOT NULL)');
    } else if (filter.appraisalState === 'unappraised') {
      where.push('NOT EXISTS (SELECT 1 FROM appraisals a WHERE a.item_id = i.id AND a.is_current = 1 AND a.value_mid IS NOT NULL)');
    }

    const rows = all(
      this.db,
      `SELECT ${ITEM_COLUMNS.split(',').map((c) => `i.${c.trim()}`).join(', ')},
              (SELECT p.id FROM photos p WHERE p.item_id = i.id ORDER BY p.is_primary DESC, p.sort_order LIMIT 1) AS primary_photo_id,
              (SELECT p.relative_path FROM photos p WHERE p.item_id = i.id ORDER BY p.is_primary DESC, p.sort_order LIMIT 1) AS primary_photo_path,
              (SELECT COUNT(*) FROM photos p2 WHERE p2.item_id = i.id) AS photo_count,
              (SELECT a.value_mid FROM appraisals a WHERE a.item_id = i.id AND a.is_current = 1 LIMIT 1) AS estimated_value,
              (SELECT a.currency FROM appraisals a WHERE a.item_id = i.id AND a.is_current = 1 LIMIT 1) AS currency
         FROM items i
        WHERE ${where.join(' AND ')}
        ORDER BY i.created_at DESC`,
      params
    );

    // Load the list-visible field values for the whole page in one pass rather
    // than per row -- a 300-item grid otherwise fires 300 extra queries.
    const listDefs = this.fieldDefs.getForCollection(filter.collectionId).filter((d) => d.showInList);
    const valuesByItem = this.loadFieldValuesForItems(
      rows.map((r) => reqStr(r.id)),
      listDefs
    );

    return rows.map((row) => {
      const id = reqStr(row.id);
      const item = toItem(row);
      return {
        ...item,
        primaryPhotoId: str(row.primary_photo_id),
        primaryPhotoPath: str(row.primary_photo_path),
        photoCount: reqNum(row.photo_count),
        estimatedValue: num(row.estimated_value),
        currency: str(row.currency),
        listFieldValues: valuesByItem.get(id) ?? [],
        searchMatch: filter.search ? findSearchMatch(filter.search, item) : null,
      };
    });
  }

  getDetail(id: string): ItemDetail | null {
    const item = this.getById(id);
    if (!item) return null;

    const defs = this.fieldDefs.getForCollection(item.collectionId);
    const history = this.appraisals.getForItem(id);

    return {
      ...item,
      photos: this.photos.getForItem(id),
      fieldValues: this.getFieldValues(id, defs),
      currentAppraisal: history.find((a) => a.isCurrent) ?? null,
      appraisalHistory: history,
    };
  }

  create(input: CreateItemInput): Item {
    const id = uuidv4();
    const timestamp = now();

    this.db.run(
      `INSERT INTO items
         (id, collection_id, name, description, notes, location, condition_grade, condition_notes,
          quantity, acquired_date, acquired_price, ai_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', ?, ?)`,
      [
        id,
        input.collectionId,
        input.name ?? '',
        input.description ?? null,
        input.notes ?? null,
        input.location ?? null,
        input.conditionGrade ?? 'unknown',
        input.conditionNotes ?? null,
        input.quantity ?? 1,
        input.acquiredDate ?? null,
        input.acquiredPrice ?? null,
        timestamp,
        timestamp,
      ]
    );

    saveDatabase(this.db);
    return this.getById(id)!;
  }

  update(id: string, input: UpdateItemInput): Item {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Item ${id} not found`);

    const update = buildUpdate({
      name: input.name,
      description: input.description === undefined ? undefined : input.description,
      notes: input.notes === undefined ? undefined : input.notes,
      location: input.location === undefined ? undefined : input.location,
      condition_grade: input.conditionGrade,
      condition_notes: input.conditionNotes === undefined ? undefined : input.conditionNotes,
      quantity: input.quantity,
      acquired_date: input.acquiredDate === undefined ? undefined : input.acquiredDate,
      acquired_price: input.acquiredPrice === undefined ? undefined : input.acquiredPrice,
    });

    if (update) {
      this.db.run(`UPDATE items SET ${update.clause}, updated_at = ? WHERE id = ?`, [...update.params, now(), id]);
      saveDatabase(this.db);
    }

    return this.getById(id)!;
  }

  /**
   * The one write path for `ai_notes`. Deliberately separate from `update()`,
   * whose input type doesn't even have an `aiNotes` field -- so a call site
   * that only means to touch the owner's own data has no way to reach this
   * column, on purpose. Called by the identify task on every run, and by the
   * "Clear" button once the owner has acted on what it flagged.
   */
  setAiNotes(id: string, aiNotes: string | null): Item {
    this.db.run(`UPDATE items SET ai_notes = ?, updated_at = ? WHERE id = ?`, [aiNotes, now(), id]);
    saveDatabase(this.db);
    return this.getById(id)!;
  }

  delete(id: string): void {
    // Photo rows cascade, but the files on disk are ours to clean up.
    this.photos.deleteForItem(id);
    this.db.run(`DELETE FROM items WHERE id = ?`, [id]);
    saveDatabase(this.db);
  }

  setAiStatus(id: string, status: ItemAiStatus, error: string | null = null): void {
    this.db.run(
      `UPDATE items SET ai_status = ?, ai_error = ?, ai_last_run_at = ?, updated_at = ? WHERE id = ?`,
      [status, error, status === 'done' || status === 'error' ? now() : null, now(), id]
    );
    saveDatabase(this.db);
  }

  /** Records which tier ('quick' or 'deep') produced the item's current identify result. */
  setAiTier(id: string, tier: Item['aiTier']): void {
    this.db.run(`UPDATE items SET ai_tier = ?, updated_at = ? WHERE id = ?`, [tier, now(), id]);
    saveDatabase(this.db);
  }

  /**
   * Folds one or more items into another: photos move over, custom fields fill
   * any gap the target has, notes are concatenated, and the sources are
   * deleted. This is the fix for auto-grouping that split one physical object
   * across several items, so a wrong grouping costs one click instead of a
   * pre-sort.
   */
  merge(sourceIds: string[], targetId: string): ItemDetail | null {
    const target = this.getById(targetId);
    if (!target) throw new Error(`Item ${targetId} not found`);

    const defs = this.fieldDefs.getForCollection(target.collectionId);
    const targetValues = new Map(this.getFieldValues(targetId, defs).map((v) => [v.fieldDefId, v]));
    const notes: string[] = target.notes ? [target.notes] : [];

    for (const sourceId of sourceIds) {
      if (sourceId === targetId) continue;
      const source = this.getById(sourceId);
      if (!source || source.collectionId !== target.collectionId) continue;

      this.photos.moveAllToItem(sourceId, targetId);

      // The target's own values win; the source only fills blanks, so merging
      // never silently overwrites something the user typed.
      const fills: FieldValueWrite[] = [];
      for (const value of this.getFieldValues(sourceId, defs)) {
        const existing = targetValues.get(value.fieldDefId);
        const targetIsEmpty =
          !existing || existing.value === null || existing.value === '' ||
          (Array.isArray(existing.value) && existing.value.length === 0);
        if (targetIsEmpty && value.value !== null) {
          fills.push({ fieldDefId: value.fieldDefId, value: value.value, fromAi: value.fromAi, confidence: value.confidence });
        }
      }
      if (fills.length > 0) this.setFieldValues(targetId, fills);

      if (source.notes) notes.push(source.notes);
      if (!target.description && source.description) {
        this.db.run(`UPDATE items SET description = ? WHERE id = ?`, [source.description, targetId]);
      }
      if (!target.name && source.name) {
        this.db.run(`UPDATE items SET name = ? WHERE id = ?`, [source.name, targetId]);
      }

      // Photos have already moved, so deleting the source must not take the
      // files with it -- go direct rather than through delete().
      this.db.run(`DELETE FROM items WHERE id = ?`, [sourceId]);
    }

    if (notes.length > 1) {
      this.db.run(`UPDATE items SET notes = ? WHERE id = ?`, [notes.join('\n\n'), targetId]);
    }

    // The merged item describes a different object than either source did, so
    // its identification and valuation are both stale.
    this.db.run(`UPDATE items SET ai_status = 'none', updated_at = ? WHERE id = ?`, [now(), targetId]);
    saveDatabase(this.db);

    return this.getDetail(targetId);
  }

  /**
   * Pulls a photo out of an item into a new one of its own -- the fix for
   * auto-grouping that lumped two different objects together.
   */
  splitPhotoToNewItem(photoId: string): Item | null {
    const photo = this.photos.getById(photoId);
    if (!photo) return null;

    const source = this.getById(photo.itemId);
    if (!source) return null;

    const created = this.create({ collectionId: source.collectionId, location: source.location });
    this.photos.moveToItem(photoId, created.id);

    return this.getById(created.id);
  }

  distinctLocations(collectionId: string): string[] {
    return all(
      this.db,
      `SELECT DISTINCT location FROM items
        WHERE collection_id = ? AND location IS NOT NULL AND location <> ''
        ORDER BY location COLLATE NOCASE`,
      [collectionId]
    ).map((r) => reqStr(r.location));
  }

  // --- custom field values -------------------------------------------------

  getFieldValues(itemId: string, defs?: FieldDef[]): ItemFieldValue[] {
    const item = this.getById(itemId);
    if (!item) return [];
    const definitions = defs ?? this.fieldDefs.getForCollection(item.collectionId);
    return this.loadFieldValuesForItems([itemId], definitions).get(itemId) ?? [];
  }

  /**
   * Reads stored values for many items at once and decodes each back to its
   * declared type. Definitions drive the decoding, so changing a field's type
   * changes how existing rows read without a migration.
   */
  private loadFieldValuesForItems(itemIds: string[], defs: FieldDef[]): Map<string, ItemFieldValue[]> {
    const result = new Map<string, ItemFieldValue[]>();
    if (itemIds.length === 0 || defs.length === 0) return result;

    const defById = new Map(defs.map((d) => [d.id, d]));
    const itemPlaceholders = itemIds.map(() => '?').join(',');
    const defPlaceholders = defs.map(() => '?').join(',');

    const rows = all(
      this.db,
      `SELECT item_id, field_def_id, value_text, value_number, value_bool, value_date, from_ai, confidence
         FROM item_field_values
        WHERE item_id IN (${itemPlaceholders}) AND field_def_id IN (${defPlaceholders})`,
      [...itemIds, ...defs.map((d) => d.id)]
    );

    for (const row of rows) {
      const itemId = reqStr(row.item_id);
      const def = defById.get(reqStr(row.field_def_id));
      if (!def) continue;

      const list = result.get(itemId) ?? [];
      list.push({
        itemId,
        fieldDefId: def.id,
        fieldKey: def.key,
        value: decodeValue(def, row),
        fromAi: bool(row.from_ai),
        confidence: num(row.confidence),
      });
      result.set(itemId, list);
    }

    // Preserve definition order so the detail form renders predictably.
    for (const [itemId, values] of result) {
      values.sort((a, b) => {
        const ai = defs.findIndex((d) => d.id === a.fieldDefId);
        const bi = defs.findIndex((d) => d.id === b.fieldDefId);
        return ai - bi;
      });
      result.set(itemId, values);
    }

    return result;
  }

  setFieldValues(itemId: string, writes: FieldValueWrite[]): ItemFieldValue[] {
    const item = this.getById(itemId);
    if (!item) throw new Error(`Item ${itemId} not found`);

    const defs = this.fieldDefs.getForCollection(item.collectionId);
    const defById = new Map(defs.map((d) => [d.id, d]));

    for (const write of writes) {
      const def = defById.get(write.fieldDefId);
      if (!def) continue;

      const encoded = encodeValue(def, write.value);

      if (encoded === null) {
        this.db.run(`DELETE FROM item_field_values WHERE item_id = ? AND field_def_id = ?`, [itemId, def.id]);
        continue;
      }

      this.db.run(
        `INSERT INTO item_field_values
           (item_id, field_def_id, value_text, value_number, value_bool, value_date, from_ai, confidence, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(item_id, field_def_id) DO UPDATE SET
           value_text = excluded.value_text,
           value_number = excluded.value_number,
           value_bool = excluded.value_bool,
           value_date = excluded.value_date,
           from_ai = excluded.from_ai,
           confidence = excluded.confidence,
           updated_at = excluded.updated_at`,
        [
          itemId,
          def.id,
          encoded.text,
          encoded.number,
          encoded.bool,
          encoded.date,
          flag(write.fromAi),
          write.confidence ?? null,
          now(),
        ]
      );
    }

    this.db.run(`UPDATE items SET updated_at = ? WHERE id = ?`, [now(), itemId]);
    saveDatabase(this.db);

    return this.getFieldValues(itemId, defs);
  }

  /** Resolves field values supplied by key (as the AI returns them) to definition ids. */
  setFieldValuesByKey(
    itemId: string,
    values: Record<string, unknown>,
    options: { fromAi: boolean; confidences?: Record<string, number> } = { fromAi: false }
  ): ItemFieldValue[] {
    const item = this.getById(itemId);
    if (!item) throw new Error(`Item ${itemId} not found`);

    const defs = this.fieldDefs.getForCollection(item.collectionId);
    const byKey = new Map(defs.map((d) => [d.key, d]));

    const writes: FieldValueWrite[] = [];
    for (const [key, value] of Object.entries(values)) {
      const def = byKey.get(key);
      if (!def) continue;
      writes.push({
        fieldDefId: def.id,
        value,
        fromAi: options.fromAi,
        confidence: options.confidences?.[key] ?? null,
      });
    }

    return this.setFieldValues(itemId, writes);
  }
}

// --- value encoding --------------------------------------------------------

interface EncodedValue {
  text: string | null;
  number: number | null;
  bool: number | null;
  date: string | null;
}

/**
 * Maps a typed value onto the four storage columns. Returning null means "no
 * value" and deletes the row, so clearing a field is the same code path as
 * never setting it.
 */
function encodeValue(def: FieldDef, value: unknown): EncodedValue | null {
  const empty: EncodedValue = { text: null, number: null, bool: null, date: null };

  if (value === null || value === undefined || value === '') return null;

  switch (def.dataType) {
    case 'number':
    case 'currency':
    case 'integer':
    case 'year': {
      const n = typeof value === 'number' ? value : Number(String(value).replace(/[^0-9.\-]/g, ''));
      if (Number.isNaN(n)) return null;
      const rounded = def.dataType === 'integer' || def.dataType === 'year' ? Math.round(n) : n;
      return { ...empty, number: rounded };
    }

    case 'boolean': {
      if (typeof value === 'boolean') return { ...empty, bool: value ? 1 : 0 };
      const text = String(value).trim().toLowerCase();
      if (['true', 'yes', 'y', '1'].includes(text)) return { ...empty, bool: 1 };
      if (['false', 'no', 'n', '0'].includes(text)) return { ...empty, bool: 0 };
      return null;
    }

    case 'date':
      return { ...empty, date: String(value) };

    case 'multi_enum': {
      const list = Array.isArray(value) ? value.map(String) : [String(value)];
      const cleaned = list.map((v) => v.trim()).filter(Boolean);
      if (cleaned.length === 0) return null;
      return { ...empty, text: JSON.stringify(cleaned) };
    }

    default:
      return { ...empty, text: String(value) };
  }
}

function decodeValue(def: FieldDef, row: Row): ItemFieldValue['value'] {
  switch (def.dataType) {
    case 'number':
    case 'currency':
    case 'integer':
    case 'year':
      return num(row.value_number);
    case 'boolean':
      return row.value_bool === null || row.value_bool === undefined ? null : bool(row.value_bool);
    case 'date':
      return str(row.value_date);
    case 'multi_enum':
      return json<string[]>(row.value_text, []);
    default:
      return str(row.value_text);
  }
}
