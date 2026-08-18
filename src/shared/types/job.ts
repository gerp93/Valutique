import { AiTask, AiTier } from './connector';

export type JobStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  /** User cancelled, either individually or by clearing the queue. */
  | 'cancelled'
  /**
   * Provider said "slow down" or "you're out of quota for now". Distinct from
   * `failed` because it is expected on subscription connectors (Claude Pro
   * usage windows) and resolves on its own -- the runner retries these after a
   * cooldown instead of surfacing them as errors.
   */
  | 'rate_limited';

export interface AiJob {
  id: string;
  task: AiTask;
  tier: AiTier;
  itemId: string | null;
  collectionId: string | null;
  connectorId: string | null;
  status: JobStatus;
  attempts: number;
  error: string | null;
  /** Earliest time the runner may pick this up again. Set when rate limited or backing off. */
  notBefore: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  webSearches: number | null;
  /** Estimated spend in the connector's pricing currency. Null for subscription/local connectors. */
  costEstimate: number | null;
  /** Milliseconds the provider call took. Feeds the batch ETA estimate. */
  durationMs: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Timestamped console output captured from a CLI connector's subprocess, if this job used one. */
  cliLog: string | null;
}

/** One line of live CLI output, broadcast as a job runs. */
export interface CliLogEvent {
  jobId: string;
  at: string;
  line: string;
}

/** Live queue state pushed to the renderer so the UI can show progress without polling. */
export interface QueueState {
  running: boolean;
  paused: boolean;
  /** Why the queue paused itself, e.g. a rate-limit cooldown with a resume time. */
  pausedReason: string | null;
  resumesAt: string | null;
  counts: Record<JobStatus, number>;
  /** The jobs currently in flight, for the activity strip. */
  active: AiJob[];
  /** Rolling estimate of when the queue drains, from observed per-job durations. */
  etaSeconds: number | null;
}

export interface EnqueueJobsInput {
  task: AiTask;
  tier: AiTier;
  itemIds: string[];
  /** Overrides the task's bound connector for this batch only. */
  connectorId?: string | null;
}

/**
 * Shown before a batch runs. The whole point of the app's cost surface: the
 * user sees what this specific run will cost on this specific connector, and
 * how long it will take, before committing.
 */
export interface BatchEstimate {
  itemCount: number;
  task: AiTask;
  tier: AiTier;
  connectorId: string | null;
  connectorName: string;
  billingMode: string;
  /** Null when the connector doesn't bill per token. */
  estimatedCost: number | null;
  currency: string;
  estimatedTokensIn: number;
  estimatedTokensOut: number;
  estimatedSearches: number;
  estimatedSeconds: number;
  /** Human-readable summary, e.g. "Free -- uses your Claude Pro subscription" or "about $4.60". */
  costSummary: string;
  /** Blocking or advisory problems, e.g. "this connector can't search the web". */
  warnings: string[];
}
