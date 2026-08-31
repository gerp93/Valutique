import { Database } from 'sql.js';
import { v4 as uuidv4 } from 'uuid';
import { AiBatch, AiJob, FailedJob, JobStatus } from '../../shared/types/job';
import { AiTask, AiTier } from '../../shared/types/connector';
import { all, one, count, reqStr, str, num, reqNum, now, Row } from './helpers';
import { saveDatabase } from './schema';

function toJob(row: Row): AiJob {
  return {
    id: reqStr(row.id),
    task: reqStr(row.task) as AiTask,
    tier: reqStr(row.tier, 'deep') as AiTier,
    itemId: str(row.item_id),
    collectionId: str(row.collection_id),
    connectorId: str(row.connector_id),
    status: reqStr(row.status, 'queued') as JobStatus,
    attempts: reqNum(row.attempts),
    error: str(row.error),
    notBefore: str(row.not_before),
    tokensIn: num(row.tokens_in),
    tokensOut: num(row.tokens_out),
    webSearches: num(row.web_searches),
    costEstimate: num(row.cost_estimate),
    durationMs: num(row.duration_ms),
    createdAt: reqStr(row.created_at),
    startedAt: str(row.started_at),
    finishedAt: str(row.finished_at),
    cliLog: str(row.cli_log),
    batchId: str(row.batch_id),
  };
}

function toBatch(row: Row): AiBatch {
  return {
    id: reqStr(row.id),
    provider: reqStr(row.provider),
    connectorId: str(row.connector_id),
    providerBatchId: reqStr(row.provider_batch_id),
    status: reqStr(row.status, 'submitted') as AiBatch['status'],
    createdAt: reqStr(row.created_at),
    checkedAt: str(row.checked_at),
  };
}

/**
 * True when nothing has since redone this job successfully. Same item, same
 * task, finished later. A job with no item (field suggestions) can never be
 * superseded this way, and stays actionable.
 */
const NOT_SUPERSEDED = `
  NOT EXISTS (
    SELECT 1 FROM ai_jobs d
     WHERE d.item_id = f.item_id AND d.task = f.task
       AND d.status = 'done' AND d.created_at > f.created_at
  )
`;

const SELECT = `
  id, task, tier, item_id, collection_id, connector_id, status, attempts, error, not_before,
  tokens_in, tokens_out, web_searches, cost_estimate, duration_ms, created_at, started_at, finished_at, cli_log, batch_id
  FROM ai_jobs
`;

const BATCH_SELECT = `
  id, provider, connector_id, provider_batch_id, status, created_at, checked_at
  FROM ai_batches
`;

/** Statuses that mean "this item/task pairing already has work outstanding". */
const PENDING_STATUSES = ['queued', 'running', 'rate_limited', 'batch_queued', 'batch_pending'];

/** Everything the runner learned from one provider call, recorded for the cost surface. */
export interface JobCompletion {
  tokensIn?: number | null;
  tokensOut?: number | null;
  webSearches?: number | null;
  costEstimate?: number | null;
  durationMs?: number | null;
  responseJson?: unknown;
}

const TERMINAL: JobStatus[] = ['done', 'failed', 'cancelled'];

export class JobService {
  constructor(private db: Database) {}

  getById(id: string): AiJob | null {
    const row = one(this.db, `SELECT ${SELECT} WHERE id = ?`, [id]);
    return row ? toJob(row) : null;
  }

  /**
   * Adds a job unless the same task is already pending for the same item --
   * clicking "appraise" twice, or re-importing photos onto an item that is
   * already queued, should not double the work.
   */
  enqueue(
    task: AiTask,
    tier: AiTier,
    itemId: string | null,
    collectionId: string | null,
    connectorId: string | null,
    runAsBatch = false
  ): AiJob | null {
    if (itemId) {
      const pending = count(
        this.db,
        `SELECT COUNT(*) FROM ai_jobs WHERE item_id = ? AND task = ? AND status IN (${PENDING_STATUSES.map(() => '?').join(',')})`,
        [itemId, task, ...PENDING_STATUSES]
      );
      if (pending > 0) return null;
    }

    // Batch jobs start life as 'batch_queued', not 'queued' -- claimable()
    // only looks at 'queued'/'rate_limited', so this is what keeps the normal
    // per-job runner from ever picking one up and running it twice.
    const id = uuidv4();
    this.db.run(
      `INSERT INTO ai_jobs (id, task, tier, item_id, collection_id, connector_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, task, tier, itemId, collectionId, connectorId, runAsBatch ? 'batch_queued' : 'queued', now()]
    );
    saveDatabase(this.db);
    return this.getById(id);
  }

  enqueueMany(
    task: AiTask,
    tier: AiTier,
    itemIds: string[],
    collectionId: string | null,
    connectorId: string | null,
    runAsBatch = false
  ): AiJob[] {
    const created: AiJob[] = [];
    for (const itemId of itemIds) {
      const job = this.enqueue(task, tier, itemId, collectionId, connectorId, runAsBatch);
      if (job) created.push(job);
    }
    return created;
  }

  // --- provider batches ------------------------------------------------------

  /**
   * Jobs waiting to be bundled into a provider batch, grouped by connector so
   * one submission covers everything currently pending for that connector.
   * Only appraise is wired up to the batch path so far.
   */
  batchQueuedByConnector(): Map<string, AiJob[]> {
    const rows = all(
      this.db,
      `SELECT ${SELECT} WHERE status = 'batch_queued' AND connector_id IS NOT NULL ORDER BY created_at`
    ).map(toJob);

    const grouped = new Map<string, AiJob[]>();
    for (const job of rows) {
      if (!job.connectorId) continue;
      const list = grouped.get(job.connectorId) ?? [];
      list.push(job);
      grouped.set(job.connectorId, list);
    }
    return grouped;
  }

  createBatch(provider: string, connectorId: string, providerBatchId: string): AiBatch {
    const id = uuidv4();
    this.db.run(
      `INSERT INTO ai_batches (id, provider, connector_id, provider_batch_id, status, created_at)
       VALUES (?, ?, ?, ?, 'submitted', ?)`,
      [id, provider, connectorId, providerBatchId, now()]
    );
    saveDatabase(this.db);
    return this.getBatchById(id)!;
  }

  getBatchById(id: string): AiBatch | null {
    const row = one(this.db, `SELECT ${BATCH_SELECT} WHERE id = ?`, [id]);
    return row ? toBatch(row) : null;
  }

  /** Batches still worth polling -- anything the provider hasn't reported as finished. */
  getOpenBatches(): AiBatch[] {
    return all(this.db, `SELECT ${BATCH_SELECT} WHERE status IN ('submitted', 'in_progress') ORDER BY created_at`).map(
      toBatch
    );
  }

  /**
   * Moves a set of newly-submitted jobs from `batch_queued` to `batch_pending`,
   * tied to the batch that now covers them. Only rows still `batch_queued` are
   * claimed -- a concurrent cancel (or a second tick that somehow saw the same
   * rows) must not resurrect a cancelled job or rewrite an already-pending one.
   */
  markJobsBatchPending(jobIds: string[], batchId: string): void {
    if (jobIds.length === 0) return;
    this.db.run(
      `UPDATE ai_jobs SET status = 'batch_pending', batch_id = ?
        WHERE status = 'batch_queued' AND id IN (${jobIds.map(() => '?').join(',')})`,
      [batchId, ...jobIds]
    );
    saveDatabase(this.db);
  }

  updateBatchStatus(id: string, status: AiBatch['status']): void {
    this.db.run(`UPDATE ai_batches SET status = ?, checked_at = ? WHERE id = ?`, [status, now(), id]);
    saveDatabase(this.db);
  }

  /** Jobs still waiting on this batch -- already-applied or retried rows are left alone. */
  getJobsForBatch(batchId: string): AiJob[] {
    return all(this.db, `SELECT ${SELECT} WHERE batch_id = ? AND status = 'batch_pending'`, [batchId]).map(toJob);
  }

  /**
   * Next jobs eligible to run. `not_before` is how both rate-limit cooldowns
   * and retry backoff are expressed, so the runner needs no timers of its own
   * and a cooldown survives a restart.
   */
  claimable(limit: number): AiJob[] {
    return all(
      this.db,
      `SELECT ${SELECT}
        WHERE status IN ('queued','rate_limited')
          AND (not_before IS NULL OR not_before <= ?)
        ORDER BY created_at
        LIMIT ?`,
      [now(), limit]
    ).map(toJob);
  }

  /** Earliest time any waiting job becomes eligible, so the UI can show "resumes at". */
  nextEligibleAt(): string | null {
    const row = one(
      this.db,
      `SELECT MIN(not_before) AS next FROM ai_jobs
        WHERE status IN ('queued','rate_limited') AND not_before IS NOT NULL`
    );
    return row ? str(row.next) : null;
  }

  /**
   * Whether anything could run right now. A connector cooling down from a rate
   * limit only ever blocks its own jobs -- `claimable()` already filters by
   * each job's own `not_before` -- so this is true whenever a *different*
   * connector still has ready work, even while one is waiting out a cooldown.
   */
  hasClaimable(): boolean {
    return this.claimable(1).length > 0;
  }

  /**
   * The rate-limit message for whichever cooling-down job resumes soonest --
   * the most relevant explanation when nothing at all can currently run.
   */
  nextRateLimitReason(): string | null {
    const row = one(
      this.db,
      `SELECT error FROM ai_jobs WHERE status = 'rate_limited' ORDER BY not_before ASC LIMIT 1`
    );
    return row ? str(row.error) : null;
  }

  markRunning(id: string): void {
    this.db.run(
      `UPDATE ai_jobs SET status = 'running', attempts = attempts + 1, started_at = ?, not_before = NULL, error = NULL
        WHERE id = ?`,
      [now(), id]
    );
    saveDatabase(this.db);
  }

  /**
   * Returns whether this actually took effect. Excludes an already-cancelled
   * row on purpose: Cancel All can race a batch result landing (see
   * JobRunner.applyBatchResult), and a job the user cancelled must stay
   * cancelled rather than being resurrected as 'done' by a result that was
   * already in flight when they clicked it.
   */
  markDone(id: string, completion: JobCompletion): boolean {
    this.db.run(
      `UPDATE ai_jobs
          SET status = 'done', finished_at = ?, error = NULL,
              tokens_in = ?, tokens_out = ?, web_searches = ?, cost_estimate = ?, duration_ms = ?,
              response_json = ?
        WHERE id = ? AND status != 'cancelled'`,
      [
        now(),
        completion.tokensIn ?? null,
        completion.tokensOut ?? null,
        completion.webSearches ?? null,
        completion.costEstimate ?? null,
        completion.durationMs ?? null,
        completion.responseJson ? JSON.stringify(completion.responseJson).slice(0, 200_000) : null,
        id,
      ]
    );
    const applied = this.db.getRowsModified() > 0;
    saveDatabase(this.db);
    return applied;
  }

  /** Returns whether this actually took effect -- see the note on markDone. */
  markFailed(id: string, error: string): boolean {
    this.db.run(`UPDATE ai_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status != 'cancelled'`, [
      error.slice(0, 4000),
      now(),
      id,
    ]);
    const applied = this.db.getRowsModified() > 0;
    saveDatabase(this.db);
    return applied;
  }

  /** Puts a job back on the queue with a delay. Used for transient errors. */
  retryAfter(id: string, delayMs: number, error: string): void {
    this.db.run(`UPDATE ai_jobs SET status = 'queued', not_before = ?, error = ? WHERE id = ?`, [
      new Date(Date.now() + delayMs).toISOString(),
      error.slice(0, 4000),
      id,
    ]);
    saveDatabase(this.db);
  }

  /**
   * Distinct from a failure: the provider is fine, we're just out of allowance
   * for now. Expected on subscription connectors, so the job waits rather than
   * consuming a retry budget.
   */
  markRateLimited(id: string, resumeAt: Date, message: string): void {
    this.db.run(
      `UPDATE ai_jobs SET status = 'rate_limited', not_before = ?, error = ?, attempts = MAX(attempts - 1, 0)
        WHERE id = ?`,
      [resumeAt.toISOString(), message.slice(0, 4000), id]
    );
    saveDatabase(this.db);
  }

  /** Stores the captured CLI console output once a job reaches a terminal state. Capped by the caller. */
  setCliLog(id: string, text: string): void {
    this.db.run(`UPDATE ai_jobs SET cli_log = ? WHERE id = ?`, [text.slice(-500_000), id]);
    saveDatabase(this.db);
  }

  cancel(id: string): void {
    this.db.run(`UPDATE ai_jobs SET status = 'cancelled', finished_at = ? WHERE id = ? AND status NOT IN ('done')`, [
      now(),
      id,
    ]);
    saveDatabase(this.db);
  }

  /**
   * Cancels every pending job (live and batch) and returns the distinct item
   * ids affected, so the caller can also clear their `ai_status` pill --
   * cancelling the job alone leaves an item looking permanently "queued"
   * otherwise, since nothing else resets it.
   */
  cancelPending(): { count: number; itemIds: string[] } {
    const cancellable = ['queued', 'rate_limited', 'batch_queued', 'batch_pending'];
    const placeholders = cancellable.map(() => '?').join(',');

    const rows = all(
      this.db,
      `SELECT DISTINCT item_id FROM ai_jobs WHERE status IN (${placeholders}) AND item_id IS NOT NULL`,
      cancellable
    );
    const itemIds = rows.map((row) => reqStr(row.item_id));

    const pending = count(this.db, `SELECT COUNT(*) FROM ai_jobs WHERE status IN (${placeholders})`, cancellable);
    this.db.run(`UPDATE ai_jobs SET status = 'cancelled', finished_at = ? WHERE status IN (${placeholders})`, [
      now(),
      ...cancellable,
    ]);
    saveDatabase(this.db);
    return { count: pending, itemIds };
  }

  /** Puts every failed job back on the queue. The "retry all" button. */
  /**
   * Retries failed jobs -- by default only the ones still worth retrying.
   *
   * A failure that was later redone successfully is history, not a to-do. Those
   * rows stay in the table (they really happened, and the cost surface reads
   * them) but re-running them would spend money re-deriving results the item
   * already has, and overwrite them with the output of a second call.
   */
  requeueFailed(jobIds?: string[]): number {
    if (jobIds && jobIds.length === 0) return 0;

    const where = jobIds
      ? `status = 'failed' AND id IN (${jobIds.map(() => '?').join(', ')})`
      : `status = 'failed' AND ${NOT_SUPERSEDED}`;
    const params = jobIds ?? [];

    const affected = count(this.db, `SELECT COUNT(*) FROM ai_jobs f WHERE ${where}`, params);
    this.db.run(
      `UPDATE ai_jobs SET status = 'queued', attempts = 0, error = NULL, not_before = NULL, finished_at = NULL
        WHERE id IN (SELECT id FROM ai_jobs f WHERE ${where})`,
      params
    );
    saveDatabase(this.db);
    return affected;
  }

  /** The failures still worth showing: newest first, with the item they belong to. */
  getFailed(): FailedJob[] {
    return all(
      this.db,
      `SELECT f.id, f.task, f.tier, f.item_id, f.error, f.attempts, f.finished_at, f.created_at,
              i.name AS item_name
         FROM ai_jobs f
         LEFT JOIN items i ON i.id = f.item_id
        WHERE f.status = 'failed' AND ${NOT_SUPERSEDED}
        ORDER BY COALESCE(f.finished_at, f.created_at) DESC`
    ).map((row) => ({
      id: reqStr(row.id),
      task: reqStr(row.task) as AiTask,
      tier: reqStr(row.tier, 'deep') as AiTier,
      itemId: str(row.item_id),
      itemName: str(row.item_name),
      error: str(row.error),
      attempts: reqNum(row.attempts),
      failedAt: str(row.finished_at) ?? reqStr(row.created_at),
    }));
  }

  getCounts(): Record<JobStatus, number> {
    const rows = all(this.db, `SELECT status, COUNT(*) AS n FROM ai_jobs GROUP BY status`);
    const counts: Record<JobStatus, number> = {
      queued: 0,
      running: 0,
      done: 0,
      failed: 0,
      cancelled: 0,
      rate_limited: 0,
      batch_queued: 0,
      batch_pending: 0,
    };
    for (const row of rows) {
      const status = reqStr(row.status) as JobStatus;
      if (status in counts) counts[status] = reqNum(row.n);
    }

    // Reported as what the user could act on, not as a running total of
    // everything that ever went wrong. Without this the button offers to retry
    // work that has already been redone.
    counts.failed = count(
      this.db,
      `SELECT COUNT(*) FROM ai_jobs f WHERE f.status = 'failed' AND ${NOT_SUPERSEDED}`
    );

    return counts;
  }

  getActive(): AiJob[] {
    return all(this.db, `SELECT ${SELECT} WHERE status = 'running' ORDER BY started_at`).map(toJob);
  }

  getRecent(limit = 50): AiJob[] {
    return all(this.db, `SELECT ${SELECT} ORDER BY created_at DESC LIMIT ?`, [limit]).map(toJob);
  }

  getForItem(itemId: string): AiJob[] {
    return all(this.db, `SELECT ${SELECT} WHERE item_id = ? ORDER BY created_at DESC`, [itemId]).map(toJob);
  }

  /**
   * Observed average duration for this task/connector pair, used to give the
   * batch estimator a real ETA instead of a guess. Falls back to the task
   * average, then to null so callers can substitute a default.
   */
  averageDurationMs(task: AiTask, connectorId: string | null): number | null {
    if (connectorId) {
      const withConnector = num(
        one(
          this.db,
          `SELECT AVG(duration_ms) AS avg FROM ai_jobs
            WHERE task = ? AND connector_id = ? AND status = 'done' AND duration_ms IS NOT NULL`,
          [task, connectorId]
        )?.avg
      );
      if (withConnector) return withConnector;
    }

    return num(
      one(this.db, `SELECT AVG(duration_ms) AS avg FROM ai_jobs WHERE task = ? AND status = 'done' AND duration_ms IS NOT NULL`, [
        task,
      ])?.avg
    );
  }

  /** Clears finished history, keeping anything still in flight. */
  clearHistory(): void {
    this.db.run(`DELETE FROM ai_jobs WHERE status IN (${TERMINAL.map(() => '?').join(',')})`, TERMINAL);
    saveDatabase(this.db);
  }
}
