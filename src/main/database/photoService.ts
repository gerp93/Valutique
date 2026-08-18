import { Database } from 'sql.js';
import { v4 as uuidv4 } from 'uuid';
import { Photo } from '../../shared/types/photo';
import { all, one, count, reqStr, reqNum, bool, flag, now, Row } from './helpers';
import { saveDatabase } from './schema';
import * as photoStore from '../photoStore';
import { IngestedPhoto } from '../photoStore';

function toPhoto(row: Row): Photo {
  return {
    id: reqStr(row.id),
    itemId: reqStr(row.item_id),
    relativePath: reqStr(row.relative_path),
    originalFilename: reqStr(row.original_filename),
    sha256: reqStr(row.sha256),
    width: reqNum(row.width),
    height: reqNum(row.height),
    byteSize: reqNum(row.byte_size),
    isPrimary: bool(row.is_primary),
    sortOrder: reqNum(row.sort_order),
    createdAt: reqStr(row.created_at),
  };
}

const SELECT = `
  id, item_id, relative_path, original_filename, sha256, width, height, byte_size,
  is_primary, sort_order, created_at
  FROM photos
`;

export class PhotoService {
  constructor(private db: Database) {}

  getForItem(itemId: string): Photo[] {
    return all(this.db, `SELECT ${SELECT} WHERE item_id = ? ORDER BY is_primary DESC, sort_order, created_at`, [
      itemId,
    ]).map(toPhoto);
  }

  getById(id: string): Photo | null {
    const row = one(this.db, `SELECT ${SELECT} WHERE id = ?`, [id]);
    return row ? toPhoto(row) : null;
  }

  /** Which item, if any, already has a photo with these exact bytes. Drives the duplicate warning on import. */
  findItemByHash(sha256: string): string | null {
    const row = one(this.db, `SELECT item_id FROM photos WHERE sha256 = ? LIMIT 1`, [sha256]);
    return row ? reqStr(row.item_id) : null;
  }

  addToItem(itemId: string, ingested: IngestedPhoto, originalFilename: string): Photo {
    const id = uuidv4();
    const existingCount = count(this.db, `SELECT COUNT(*) FROM photos WHERE item_id = ?`, [itemId]);

    this.db.run(
      `INSERT INTO photos
         (id, item_id, relative_path, original_filename, sha256, width, height, byte_size,
          is_primary, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        itemId,
        ingested.relativePath,
        originalFilename,
        ingested.sha256,
        ingested.width,
        ingested.height,
        ingested.byteSize,
        // First photo on an item becomes its cover automatically.
        flag(existingCount === 0),
        existingCount,
        now(),
      ]
    );

    saveDatabase(this.db);
    return this.getById(id)!;
  }

  setPrimary(photoId: string): void {
    const photo = this.getById(photoId);
    if (!photo) return;
    this.db.run(`UPDATE photos SET is_primary = 0 WHERE item_id = ?`, [photo.itemId]);
    this.db.run(`UPDATE photos SET is_primary = 1 WHERE id = ?`, [photoId]);
    saveDatabase(this.db);
  }

  reorder(itemId: string, orderedIds: string[]): Photo[] {
    orderedIds.forEach((id, index) => {
      this.db.run(`UPDATE photos SET sort_order = ? WHERE id = ? AND item_id = ?`, [index, id, itemId]);
    });
    saveDatabase(this.db);
    return this.getForItem(itemId);
  }

  /**
   * Moves a photo to a different item. This is the primitive behind both
   * "split this photo out into its own item" and dragging a photo between item
   * cards on the import review screen -- the two ways a wrong auto-grouping
   * gets corrected.
   */
  moveToItem(photoId: string, targetItemId: string): Photo | null {
    const photo = this.getById(photoId);
    if (!photo) return null;
    if (photo.itemId === targetItemId) return photo;

    const targetCount = count(this.db, `SELECT COUNT(*) FROM photos WHERE item_id = ?`, [targetItemId]);

    this.db.run(`UPDATE photos SET item_id = ?, sort_order = ?, is_primary = ? WHERE id = ?`, [
      targetItemId,
      targetCount,
      flag(targetCount === 0),
      photoId,
    ]);

    this.ensurePrimary(photo.itemId);
    saveDatabase(this.db);

    return this.getById(photoId);
  }

  /** Moves every photo from one item onto another, preserving order. Used by item merge. */
  moveAllToItem(sourceItemId: string, targetItemId: string): void {
    let next = count(this.db, `SELECT COUNT(*) FROM photos WHERE item_id = ?`, [targetItemId]);
    for (const photo of this.getForItem(sourceItemId)) {
      this.db.run(`UPDATE photos SET item_id = ?, sort_order = ?, is_primary = 0 WHERE id = ?`, [
        targetItemId,
        next,
        photo.id,
      ]);
      next += 1;
    }
    this.ensurePrimary(targetItemId);
    saveDatabase(this.db);
  }

  /** After any move or delete, make sure the item still has exactly one cover photo. */
  private ensurePrimary(itemId: string): void {
    const hasPrimary = count(this.db, `SELECT COUNT(*) FROM photos WHERE item_id = ? AND is_primary = 1`, [itemId]);
    if (hasPrimary > 0) return;
    const first = one(this.db, `SELECT id FROM photos WHERE item_id = ? ORDER BY sort_order LIMIT 1`, [itemId]);
    if (first) {
      this.db.run(`UPDATE photos SET is_primary = 1 WHERE id = ?`, [reqStr(first.id)]);
    }
  }

  delete(photoId: string): void {
    const photo = this.getById(photoId);
    if (!photo) return;

    this.db.run(`DELETE FROM photos WHERE id = ?`, [photoId]);
    this.ensurePrimary(photo.itemId);
    this.removeFileIfOrphaned(photo.sha256, photo.relativePath);

    saveDatabase(this.db);
  }

  deleteForItem(itemId: string): void {
    const photos = this.getForItem(itemId);
    this.db.run(`DELETE FROM photos WHERE item_id = ?`, [itemId]);
    for (const photo of photos) {
      this.removeFileIfOrphaned(photo.sha256, photo.relativePath);
    }
    saveDatabase(this.db);
  }

  /**
   * The library is content-addressed, so two items can legitimately share one
   * file. Only delete the bytes once no row references that hash any more.
   */
  private removeFileIfOrphaned(sha256: string, relativePath: string): void {
    const remaining = count(this.db, `SELECT COUNT(*) FROM photos WHERE sha256 = ?`, [sha256]);
    if (remaining === 0) {
      photoStore.remove(relativePath);
    }
  }
}
