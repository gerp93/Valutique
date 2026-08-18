import { AiConnector } from '../../shared/types/connector';

/**
 * Turns token and search counts into money.
 *
 * The same function computes both the estimate shown before a batch runs and
 * the figure recorded after each job, so what the user was quoted and what they
 * are told they spent are never computed two different ways.
 */

export interface UsageCounts {
  tokensIn: number | null;
  tokensOut: number | null;
  webSearches: number | null;
}

/**
 * Returns null -- not zero -- for connectors that aren't metered. A subscription
 * or local connector has no dollar cost to report, and showing "$0.00" would
 * imply a meter that was never running.
 */
export function estimateCost(connector: AiConnector, usage: UsageCounts): number | null {
  if (connector.billingMode !== 'api_credits') return null;

  const { inputPerMTok, outputPerMTok, webSearchPerThousand } = connector.pricing;
  if (inputPerMTok === null && outputPerMTok === null && webSearchPerThousand === null) return null;

  const input = ((usage.tokensIn ?? 0) / 1_000_000) * (inputPerMTok ?? 0);
  const output = ((usage.tokensOut ?? 0) / 1_000_000) * (outputPerMTok ?? 0);
  const search = ((usage.webSearches ?? 0) / 1000) * (webSearchPerThousand ?? 0);

  return input + output + search;
}

/**
 * Rough per-item token expectations, used before anything has run.
 *
 * These are starting points only. Once jobs have actually completed, the batch
 * estimator prefers the user's own observed averages -- their photos, their
 * field count, their model -- over anything hardcoded here.
 */
export const TASK_TOKEN_BASELINE = {
  identify: { tokensIn: 4000, tokensOut: 700, searches: 0, seconds: 12 },
  appraise: { tokensIn: 25000, tokensOut: 1200, searches: 3, seconds: 35 },
  suggest_fields: { tokensIn: 900, tokensOut: 900, searches: 0, seconds: 10 },
} as const;

/** CLI connectors pay process-launch and agent-loop overhead an API call doesn't. */
export const CLI_SLOWDOWN_FACTOR = 5;

export function formatCost(amount: number | null, currency: string): string {
  if (amount === null) return '—';
  if (amount === 0) return `0.00 ${currency}`;
  // Sub-cent figures are the norm per item, so don't round them away to $0.00.
  if (amount < 0.01) return `<0.01 ${currency}`;
  return `${amount.toFixed(2)} ${currency}`;
}
