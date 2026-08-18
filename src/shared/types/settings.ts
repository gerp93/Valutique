export interface AppSettings {
  /** How many AI jobs run at once. CLI connectors want a low number; APIs tolerate more. */
  jobConcurrency: number;
  /** Long edge in pixels that photos are downscaled to before being sent to a model. Dominates per-item cost. */
  aiImageMaxEdge: number;
  /** How many photos of an item to send. More angles help ID; each one costs tokens. */
  aiMaxPhotosPerItem: number;
  /** Automatically queue identify + appraise when photos are added. The "drop it and walk away" switch. */
  autoProcessOnImport: boolean;
  /** Run appraise automatically once identify succeeds. */
  autoAppraiseAfterIdentify: boolean;
  /** Cap on provider-side web searches per appraisal. The main cost lever on the appraise task. */
  maxSearchesPerAppraisal: number;
  /** Check every comp URL resolves before saving it. */
  verifyCompUrls: boolean;
  defaultCurrency: string;
  /** eBay Browse API app credentials, used to supplement search with structured listing data. */
  ebayEnabled: boolean;
  hasEbayCredentials: boolean;
}

export type UpdateSettingsInput = Partial<Omit<AppSettings, 'hasEbayCredentials'>> & {
  ebayClientId?: string | null;
  ebayClientSecret?: string | null;
};

export interface DbLocationInfo {
  path: string;
  isDefault: boolean;
  defaultPath: string;
}

export interface MediaLocationInfo {
  path: string;
  isDefault: boolean;
  defaultPath: string;
  fileCount: number;
  totalBytes: number;
}

export interface UpdateCheckResult {
  status: 'available' | 'not-available' | 'error' | 'unsupported';
  version?: string;
  message?: string;
}
