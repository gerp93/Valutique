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
  | 'rate_limited'
  /**
   * Chose to run as a provider batch, but not yet bundled into a submitted
   * batch request. Deliberately excluded from `claimable()` -- the normal
   * per-job runner must never pick these up, or they'd run twice.
   */
  | 'batch_queued'
  /**
   * Submitted to the provider as part of a batch and waiting on it, possibly
   * for hours and across an app restart. Distinct from `running` so a restart
   * never mistakes "waiting on a remote batch" for "crashed mid-call" and
   * requeues it -- see recoverInterruptedJobs in schema.ts.
   */
  | 'batch_pending';

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
  /** Set once this job has been bundled into a submitted provider batch. Null for every normal job. */
  batchId: string | null;
}

/**
 * One provider-side batch request, covering many jobs. Lives independently of
 * the jobs it covers because a batch is checked and resolved as a unit -- the
 * provider only ever tells you "the whole batch is done", never one job at a
 * time.
 */
export interface AiBatch {
  id: string;
  provider: string;
  /** Null if the connector was since deleted -- the batch record and its jobs are kept for history. */
  connectorId: string | null;
  /**
   * The id the provider itself assigned, used for every retrieve/results
   * call. Null only while `status` is 'submitting' -- claimed locally (its
   * jobs are already `batch_pending`) but the provider hasn't accepted the
   * submission yet, so there's nothing to poll.
   */
  providerBatchId: string | null;
  status: 'submitting' | 'submitted' | 'in_progress' | 'ended' | 'failed';
  createdAt: string;
  /** Last time the app actually asked the provider for this batch's status. */
  checkedAt: string | null;
}

/**
 * A failure still worth acting on -- one that has not since been redone
 * successfully. Shown so the user can pick what to retry instead of re-running
 * everything that ever went wrong.
 */
export interface FailedJob {
  id: string;
  task: AiTask;
  tier: AiTier;
  itemId: string | null;
  itemName: string | null;
  error: string | null;
  attempts: number;
  failedAt: string;
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
  /**
   * Run via the provider's async Batch API instead of the normal queue --
   * about half the token cost, but the answer may take up to a day and the
   * app does not need to stay open while it waits. Only meaningful for
   * connectors whose provider actually implements batching (currently
   * Anthropic, appraise only); ignored otherwise.
   */
  runAsBatch?: boolean;
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
  /**
   * Whether this task/connector pair can actually run through the provider's
   * async Batch API. Only true for appraise on a connector whose provider
   * implements batching (Anthropic, so far) -- the "Run as batch" checkbox is
   * only worth offering when this is true.
   */
  canRunAsBatch: boolean;
}
