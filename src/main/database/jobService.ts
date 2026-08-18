import { Database } from 'sql.js';
import { v4 as uuidv4 } from 'uuid';
import { AiJob, JobStatus } from '../../shared/types/job';
import { AiTask } from '../../shared/types/connector';
import { all, one, count, reqStr, str, num, reqNum, now, Row } from './helpers';
import { saveDatabase } from './schema';

function toJob(row: Row): AiJob {
  return {
    id: reqStr(row.id),
    task: reqStr(row.task) as AiTask,
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
  };
}

const SELECT = `
  id, task, item_id, collection_id, connector_id, status, attempts, error, not_before,
  tokens_in, tokens_out, web_searches, cost_estimate, duration_ms, created_at, started_at, finished_at, cli_log
  FROM ai_jobs
`;

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
  enqueue(task: AiTask, itemId: string | null, collectionId: string | null, connectorId: string | null): AiJob | null {
    if (itemId) {
      const pending = count(
        this.db,
        `SELECT COUNT(*) FROM ai_jobs WHERE item_id = ? AND task = ? AND status IN ('queued','running','rate_limited')`,
        [itemId, task]
      );
      if (pending > 0) return null;
    }

    const id = uuidv4();
    this.db.run(
      `INSERT INTO ai_jobs (id, task, item_id, collection_id, connector_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?)`,
      [id, task, itemId, collectionId, connectorId, now()]
    );
    saveDatabase(this.db);
    return this.getById(id);
  }

  enqueueMany(task: AiTask, itemIds: string[], collectionId: string | null, connectorId: string | null): AiJob[] {
    const created: AiJob[] = [];
    for (const itemId of itemIds) {
      const job = this.enqueue(task, itemId, collectionId, connectorId);
      if (job) created.push(job);
    }
    return created;
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

  markDone(id: string, completion: JobCompletion): void {
    this.db.run(
      `UPDATE ai_jobs
          SET status = 'done', finished_at = ?, error = NULL,
              tokens_in = ?, tokens_out = ?, web_searches = ?, cost_estimate = ?, duration_ms = ?,
              response_json = ?
        WHERE id = ?`,
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
    saveDatabase(this.db);
  }

  markFailed(id: string, error: string): void {
    this.db.run(`UPDATE ai_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`, [
      error.slice(0, 4000),
      now(),
      id,
    ]);
    saveDatabase(this.db);
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

  cancelPending(): number {
    const pending = count(this.db, `SELECT COUNT(*) FROM ai_jobs WHERE status IN ('queued','rate_limited')`);
    this.db.run(`UPDATE ai_jobs SET status = 'cancelled', finished_at = ? WHERE status IN ('queued','rate_limited')`, [
      now(),
    ]);
    saveDatabase(this.db);
    return pending;
  }

  /** Puts every failed job back on the queue. The "retry all" button. */
  requeueFailed(): number {
    const failed = count(this.db, `SELECT COUNT(*) FROM ai_jobs WHERE status = 'failed'`);
    this.db.run(
      `UPDATE ai_jobs SET status = 'queued', attempts = 0, error = NULL, not_before = NULL, finished_at = NULL
        WHERE status = 'failed'`
    );
    saveDatabase(this.db);
    return failed;
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
    };
    for (const row of rows) {
      const status = reqStr(row.status) as JobStatus;
      if (status in counts) counts[status] = reqNum(row.n);
    }
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
