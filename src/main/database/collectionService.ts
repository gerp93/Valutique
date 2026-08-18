import { Database } from 'sql.js';
import { v4 as uuidv4 } from 'uuid';
import {
  Collection,
  CollectionSummary,
  CreateCollectionInput,
  UpdateCollectionInput,
} from '../../shared/types/collection';
import { all, one, reqStr, str, reqNum, now, buildUpdate, Row } from './helpers';
import { saveDatabase } from './schema';

function toCollection(row: Row): Collection {
  return {
    id: reqStr(row.id),
    name: reqStr(row.name),
    itemNoun: reqStr(row.item_noun, 'item'),
    description: str(row.description),
    createdAt: reqStr(row.created_at),
    updatedAt: reqStr(row.updated_at),
  };
}

const SELECT = `
  id, name, item_noun, description, created_at, updated_at
  FROM collections
`;

export class CollectionService {
  constructor(private db: Database) {}

  getAll(): Collection[] {
    return all(this.db, `SELECT ${SELECT} ORDER BY name COLLATE NOCASE`).map(toCollection);
  }

  getById(id: string): Collection | null {
    const row = one(this.db, `SELECT ${SELECT} WHERE id = ?`, [id]);
    return row ? toCollection(row) : null;
  }

  /**
   * Collections list with roll-ups. The value total deliberately counts only
   * items that actually have a current appraisal, and reports the unappraised
   * count alongside it, so a half-processed collection never looks like a
   * complete valuation.
   */
  getSummaries(): CollectionSummary[] {
    const rows = all(
      this.db,
      `SELECT c.id, c.name, c.item_noun, c.description, c.created_at, c.updated_at,
              (SELECT COUNT(*) FROM items i WHERE i.collection_id = c.id) AS item_count,
              (SELECT COUNT(*) FROM photos p
                 JOIN items i2 ON i2.id = p.item_id
                WHERE i2.collection_id = c.id) AS photo_count,
              (SELECT COALESCE(SUM(a.value_mid * i3.quantity), 0) FROM appraisals a
                 JOIN items i3 ON i3.id = a.item_id
                WHERE i3.collection_id = c.id AND a.is_current = 1 AND a.value_mid IS NOT NULL) AS estimated_value,
              (SELECT COUNT(*) FROM items i4
                WHERE i4.collection_id = c.id
                  AND NOT EXISTS (SELECT 1 FROM appraisals a2
                                   WHERE a2.item_id = i4.id AND a2.is_current = 1 AND a2.value_mid IS NOT NULL)
              ) AS unappraised_count
         FROM collections c
        ORDER BY c.name COLLATE NOCASE`
    );

    return rows.map((row) => ({
      ...toCollection(row),
      itemCount: reqNum(row.item_count),
      photoCount: reqNum(row.photo_count),
      estimatedValue: reqNum(row.estimated_value),
      unappraisedCount: reqNum(row.unappraised_count),
    }));
  }

  create(input: CreateCollectionInput): Collection {
    const id = uuidv4();
    const timestamp = now();

    this.db.run(
      `INSERT INTO collections (id, name, item_noun, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, input.name, input.itemNoun || 'item', input.description ?? null, timestamp, timestamp]
    );

    saveDatabase(this.db);
    return this.getById(id)!;
  }

  update(id: string, input: UpdateCollectionInput): Collection {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Collection ${id} not found`);

    const update = buildUpdate({
      name: input.name,
      item_noun: input.itemNoun,
      description: input.description === undefined ? undefined : input.description,
    });

    if (update) {
      this.db.run(`UPDATE collections SET ${update.clause}, updated_at = ? WHERE id = ?`, [
        ...update.params,
        now(),
        id,
      ]);
      saveDatabase(this.db);
    }

    return this.getById(id)!;
  }

  /** Cascades to field defs, items, field values, photos, appraisals, and comps via foreign keys. */
  delete(id: string): void {
    this.db.run(`DELETE FROM collections WHERE id = ?`, [id]);
    saveDatabase(this.db);
  }
}
