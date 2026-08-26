export interface Collection {
  id: string;
  name: string;
  /** What one entry is called in this collection -- "toy", "figure", "coin". Used in UI copy and AI prompts. */
  itemNoun: string;
  /** Free-text description of what's collected. Feeds the AI prompts so the model knows the domain. */
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCollectionInput {
  name: string;
  itemNoun: string;
  description?: string | null;
}

export interface UpdateCollectionInput {
  name?: string;
  itemNoun?: string;
  description?: string | null;
}

/** Roll-up shown on the collections list -- computed, not stored. */
export interface CollectionSummary extends Collection {
  itemCount: number;
  photoCount: number;
  /**
   * Sum of the current appraisal midpoint across items still owned. Sold pieces
   * are excluded: this answers "what is my collection worth", and something
   * already sold is not part of it -- what it fetched is in `soldTotal`.
   */
  estimatedValue: number;
  /** Items still owned with no current appraisal, so the user knows the total is incomplete. */
  unappraisedCount: number;
  soldCount: number;
  /** What sold pieces actually fetched, which is money in hand rather than an estimate. */
  soldTotal: number;
}
