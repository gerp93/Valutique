import { Database } from 'sql.js';
import { AppSettings, UpdateSettingsInput } from '../../shared/types/settings';
import { one, reqStr, reqNum, bool, flag, now, buildUpdate } from './helpers';
import { saveDatabase } from './schema';
import { EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, getSecret, hasSecret, setSecret } from '../secrets';

export class SettingsService {
  constructor(private db: Database) {}

  get(): AppSettings {
    const row = one(
      this.db,
      `SELECT job_concurrency, ai_image_max_edge, ai_max_photos_per_item, auto_process_on_import,
              auto_appraise_after_identify, max_searches_per_appraisal, verify_comp_urls,
              default_currency, ebay_enabled
         FROM app_settings WHERE id = 1`
    );

    return {
      jobConcurrency: reqNum(row?.job_concurrency, 2),
      aiImageMaxEdge: reqNum(row?.ai_image_max_edge, 1024),
      aiMaxPhotosPerItem: reqNum(row?.ai_max_photos_per_item, 3),
      autoProcessOnImport: row ? bool(row.auto_process_on_import) : true,
      autoAppraiseAfterIdentify: row ? bool(row.auto_appraise_after_identify) : true,
      maxSearchesPerAppraisal: reqNum(row?.max_searches_per_appraisal, 3),
      verifyCompUrls: row ? bool(row.verify_comp_urls) : true,
      defaultCurrency: reqStr(row?.default_currency, 'USD'),
      ebayEnabled: row ? bool(row.ebay_enabled) : false,
      hasEbayCredentials: hasSecret(EBAY_CLIENT_ID) && hasSecret(EBAY_CLIENT_SECRET),
    };
  }

  update(input: UpdateSettingsInput): AppSettings {
    const update = buildUpdate({
      // Concurrency is clamped: CLI connectors spawn a process per job, and
      // letting someone type 50 here would fork-bomb their machine.
      job_concurrency: input.jobConcurrency === undefined ? undefined : clamp(input.jobConcurrency, 1, 8),
      ai_image_max_edge: input.aiImageMaxEdge === undefined ? undefined : clamp(input.aiImageMaxEdge, 256, 2048),
      ai_max_photos_per_item:
        input.aiMaxPhotosPerItem === undefined ? undefined : clamp(input.aiMaxPhotosPerItem, 1, 8),
      auto_process_on_import: input.autoProcessOnImport === undefined ? undefined : flag(input.autoProcessOnImport),
      auto_appraise_after_identify:
        input.autoAppraiseAfterIdentify === undefined ? undefined : flag(input.autoAppraiseAfterIdentify),
      max_searches_per_appraisal:
        input.maxSearchesPerAppraisal === undefined ? undefined : clamp(input.maxSearchesPerAppraisal, 0, 10),
      verify_comp_urls: input.verifyCompUrls === undefined ? undefined : flag(input.verifyCompUrls),
      default_currency: input.defaultCurrency,
      ebay_enabled: input.ebayEnabled === undefined ? undefined : flag(input.ebayEnabled),
    });

    if (update) {
      this.db.run(`UPDATE app_settings SET ${update.clause}, updated_at = ? WHERE id = 1`, [...update.params, now()]);
      saveDatabase(this.db);
    }

    // eBay credentials follow the same undefined-vs-null convention as
    // connector API keys: undefined leaves them alone, null clears them.
    if (input.ebayClientId !== undefined) setSecret(EBAY_CLIENT_ID, input.ebayClientId);
    if (input.ebayClientSecret !== undefined) setSecret(EBAY_CLIENT_SECRET, input.ebayClientSecret);

    return this.get();
  }

  /** Main-process only. eBay credentials are never sent to the renderer. */
  getEbayCredentials(): { clientId: string; clientSecret: string } | null {
    const clientId = getSecret(EBAY_CLIENT_ID);
    const clientSecret = getSecret(EBAY_CLIENT_SECRET);
    if (!clientId || !clientSecret) return null;
    return { clientId, clientSecret };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}
