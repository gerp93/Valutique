import { Database } from 'sql.js';
import { v4 as uuidv4 } from 'uuid';
import { Appraisal, AppraisalComp, CreateAppraisalInput } from '../../shared/types/appraisal';
import { all, reqStr, str, num, bool, flag, now, Row } from './helpers';
import { saveDatabase } from './schema';

function toAppraisal(row: Row, comps: AppraisalComp[]): Appraisal {
  return {
    id: reqStr(row.id),
    itemId: reqStr(row.item_id),
    connectorId: str(row.connector_id),
    connectorLabel: reqStr(row.connector_label),
    model: str(row.model),
    valueLow: num(row.value_low),
    valueMid: num(row.value_mid),
    valueHigh: num(row.value_high),
    currency: reqStr(row.currency, 'USD'),
    conditionAssessed: str(row.condition_assessed),
    confidence: num(row.confidence),
    rationale: str(row.rationale),
    isCurrent: bool(row.is_current),
    searchUnavailable: bool(row.search_unavailable),
    createdAt: reqStr(row.created_at),
    comps,
  };
}

function toComp(row: Row): AppraisalComp {
  const verified = row.url_verified;
  return {
    id: reqStr(row.id),
    appraisalId: reqStr(row.appraisal_id),
    source: reqStr(row.source),
    title: reqStr(row.title),
    url: reqStr(row.url),
    price: num(row.price),
    currency: str(row.currency),
    soldDate: str(row.sold_date),
    condition: str(row.condition),
    listingType: reqStr(row.listing_type, 'unknown') as AppraisalComp['listingType'],
    similarityNote: str(row.similarity_note),
    urlVerified: verified === null || verified === undefined ? null : bool(verified),
    createdAt: reqStr(row.created_at),
  };
}

const SELECT = `
  id, item_id, connector_id, connector_label, model, value_low, value_mid, value_high,
  currency, condition_assessed, confidence, rationale, is_current, search_unavailable, created_at
  FROM appraisals
`;

export class AppraisalService {
  constructor(private db: Database) {}

  /** Newest first. The whole history is kept so a number always has its evidence. */
  getForItem(itemId: string): Appraisal[] {
    const rows = all(this.db, `SELECT ${SELECT} WHERE item_id = ? ORDER BY created_at DESC`, [itemId]);
    if (rows.length === 0) return [];

    const compsByAppraisal = this.loadComps(rows.map((r) => reqStr(r.id)));
    return rows.map((row) => toAppraisal(row, compsByAppraisal.get(reqStr(row.id)) ?? []));
  }

  getCurrent(itemId: string): Appraisal | null {
    const rows = all(this.db, `SELECT ${SELECT} WHERE item_id = ? AND is_current = 1 LIMIT 1`, [itemId]);
    if (rows.length === 0) return null;
    const comps = this.loadComps([reqStr(rows[0].id)]);
    return toAppraisal(rows[0], comps.get(reqStr(rows[0].id)) ?? []);
  }

  private loadComps(appraisalIds: string[]): Map<string, AppraisalComp[]> {
    const result = new Map<string, AppraisalComp[]>();
    if (appraisalIds.length === 0) return result;

    const placeholders = appraisalIds.map(() => '?').join(',');
    const rows = all(
      this.db,
      `SELECT id, appraisal_id, source, title, url, price, currency, sold_date, condition,
              listing_type, similarity_note, url_verified, created_at
         FROM appraisal_comps
        WHERE appraisal_id IN (${placeholders})
        ORDER BY created_at`,
      appraisalIds
    );

    for (const row of rows) {
      const key = reqStr(row.appraisal_id);
      const list = result.get(key) ?? [];
      list.push(toComp(row));
      result.set(key, list);
    }

    return result;
  }

  /**
   * Records a new appraisal and demotes the previous one. Nothing is deleted --
   * re-appraising an item a year later leaves both numbers and both sets of
   * comps in place, which is what makes value-over-time possible later.
   */
  create(input: CreateAppraisalInput): Appraisal {
    const id = uuidv4();
    const timestamp = now();

    this.db.run(`UPDATE appraisals SET is_current = 0 WHERE item_id = ?`, [input.itemId]);

    this.db.run(
      `INSERT INTO appraisals
         (id, item_id, connector_id, connector_label, model, value_low, value_mid, value_high,
          currency, condition_assessed, confidence, rationale, is_current, search_unavailable, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [
        id,
        input.itemId,
        input.connectorId,
        input.connectorLabel,
        input.model,
        input.valueLow,
        input.valueMid,
        input.valueHigh,
        input.currency,
        input.conditionAssessed,
        input.confidence,
        input.rationale,
        flag(input.searchUnavailable),
        timestamp,
      ]
    );

    for (const comp of input.comps) {
      this.db.run(
        `INSERT INTO appraisal_comps
           (id, appraisal_id, source, title, url, price, currency, sold_date, condition,
            listing_type, similarity_note, url_verified, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          id,
          comp.source,
          comp.title,
          comp.url,
          comp.price,
          comp.currency,
          comp.soldDate,
          comp.condition,
          comp.listingType,
          comp.similarityNote,
          comp.urlVerified === null ? null : flag(comp.urlVerified),
          timestamp,
        ]
      );
    }

    saveDatabase(this.db);
    return this.getCurrent(input.itemId)!;
  }

  delete(id: string): void {
    const row = all(this.db, `SELECT item_id, is_current FROM appraisals WHERE id = ?`, [id])[0];
    this.db.run(`DELETE FROM appraisals WHERE id = ?`, [id]);

    // If the current appraisal was removed, promote the next most recent so the
    // item doesn't silently lose its value.
    if (row && bool(row.is_current)) {
      const itemId = reqStr(row.item_id);
      const next = all(this.db, `SELECT id FROM appraisals WHERE item_id = ? ORDER BY created_at DESC LIMIT 1`, [
        itemId,
      ])[0];
      if (next) {
        this.db.run(`UPDATE appraisals SET is_current = 1 WHERE id = ?`, [reqStr(next.id)]);
      }
    }

    saveDatabase(this.db);
  }
}
