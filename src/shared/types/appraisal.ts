import { AiTier } from './connector';

export interface Appraisal {
  id: string;
  itemId: string;
  /** Which tier produced this appraisal -- 'quick' means a single unverified read, 'deep' means searched and verified comps. */
  tier: AiTier;
  connectorId: string | null;
  /** Snapshot of the connector name + model at run time, so history stays readable after a connector is edited or deleted. */
  connectorLabel: string;
  model: string | null;
  valueLow: number | null;
  valueMid: number | null;
  valueHigh: number | null;
  currency: string;
  /** Condition the model assessed from the photos, which may differ from the owner's grade. */
  conditionAssessed: string | null;
  /** 0-1 self-reported confidence. */
  confidence: number | null;
  /** The model's reasoning, kept so a number is never presented without its justification. */
  rationale: string | null;
  /** True for the newest appraisal on the item; only one per item. */
  isCurrent: boolean;
  /** Set when the connector had no web search available, so the value came from model knowledge alone. */
  searchUnavailable: boolean;
  createdAt: string;
  comps: AppraisalComp[];
}

/**
 * A comparable listing the appraisal leaned on. Stored per-appraisal (not
 * per-item) so re-running appraisal doesn't destroy the evidence behind the
 * previous number.
 */
export interface AppraisalComp {
  id: string;
  appraisalId: string;
  /** "ebay", "worthpoint", "hobbydb", or whatever domain the model cited. */
  source: string;
  title: string;
  url: string;
  price: number | null;
  currency: string | null;
  /** ISO date of the sale/listing, when the source gave one. */
  soldDate: string | null;
  condition: string | null;
  /** Whether this comp was a completed sale or an active asking price -- they are not the same evidence. */
  listingType: 'sold' | 'active' | 'unknown';
  /** How this comp relates to the item, e.g. "same casting, box missing". */
  similarityNote: string | null;
  /**
   * Result of a HEAD request against the URL. A model asked for comp links
   * without search will invent plausible ones, so an unverified link is shown
   * with a warning rather than presented as a source.
   */
  urlVerified: boolean | null;
  createdAt: string;
}

export interface CreateAppraisalInput {
  itemId: string;
  tier: AiTier;
  connectorId: string | null;
  connectorLabel: string;
  model: string | null;
  valueLow: number | null;
  valueMid: number | null;
  valueHigh: number | null;
  currency: string;
  conditionAssessed: string | null;
  confidence: number | null;
  rationale: string | null;
  searchUnavailable: boolean;
  comps: Omit<AppraisalComp, 'id' | 'appraisalId' | 'createdAt'>[];
}
