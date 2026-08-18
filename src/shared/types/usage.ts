import { AiTask, BillingMode } from './connector';

/** Lifetime totals for one connector, aggregated from the job log. */
export interface ConnectorUsage {
  connectorId: string;
  connectorName: string;
  billingMode: BillingMode;
  currency: string;
  jobsCompleted: number;
  jobsFailed: number;
  tokensIn: number;
  tokensOut: number;
  webSearches: number;
  /** Null for subscription and local connectors -- there is no dollar figure to report. */
  estimatedSpend: number | null;
  avgDurationMs: number | null;
  lastUsedAt: string | null;
}

export interface TaskUsage {
  task: AiTask;
  jobsCompleted: number;
  tokensIn: number;
  tokensOut: number;
  estimatedSpend: number;
}

/** Everything the Cost & Usage screen renders. */
export interface UsageReport {
  byConnector: ConnectorUsage[];
  byTask: TaskUsage[];
  /** Sum across api_credits connectors only. */
  totalEstimatedSpend: number;
  currency: string;
  /** Jobs that ran on subscription or local connectors -- the work that cost nothing. */
  freeJobsCompleted: number;
  /** What those free jobs would have cost on the most expensive configured paid connector. Motivating, and honest about the alternative. */
  estimatedSavings: number | null;
  since: string | null;
}
