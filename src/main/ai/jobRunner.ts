import { AiJob, CliLogEvent, QueueState } from '../../shared/types/job';
import { AiTask } from '../../shared/types/connector';
import { ConnectorService } from '../database/connectorService';
import { ItemService } from '../database/itemService';
import { JobService } from '../database/jobService';
import { SettingsService } from '../database/settingsService';
import { AiTasks } from './tasks';
import { AiAuthError, AiCapabilityError, AiError, AiRateLimitError } from './errors';

/**
 * The queue worker.
 *
 * Everything here exists to make a 300-item batch survivable. Jobs live in the
 * database rather than memory, so a crash, a quit, or a rate-limit window that
 * outlasts the session costs nothing. Rate limiting is treated as an expected
 * outcome rather than a failure -- on a subscription connector it certainly is
 * -- so hitting a usage window pauses the queue and schedules a resume instead
 * of producing hundreds of red rows.
 */

const POLL_INTERVAL_MS = 2000;

/** Transient failures get a few tries with widening gaps before being called a failure. */
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [15_000, 60_000, 180_000];

/** Caps a runaway CLI job's log at a sane size rather than growing unbounded in memory or in the database. */
const MAX_LOG_LINES = 2000;

export type QueueListener = (state: QueueState) => void;

export class JobRunner {
  private timer: NodeJS.Timeout | null = null;
  private active = new Map<string, AbortController>();
  private listeners = new Set<QueueListener>();
  // Manual pause only. A rate limit is a property of one connector, not the
  // whole queue -- it is tracked per-job (`not_before`, see jobService) so
  // that a Gemini cooldown never blocks an Anthropic job sitting right next
  // to it in the queue. See getState() for how "paused" is now derived.
  private paused = false;
  private stopped = true;
  /** Log-so-far for every currently active job, keyed by job id, for a console panel opened mid-run. */
  private liveLogs = new Map<string, string[]>();

  constructor(
    private jobs: JobService,
    private connectors: ConnectorService,
    private items: ItemService,
    private settings: SettingsService,
    private tasks: AiTasks,
    private onIdentifyComplete: (itemId: string) => void,
    private onCliOutput: (event: CliLogEvent) => void
  ) {}

  /** The log captured so far for a still-running job, for a console panel that opens mid-run. */
  getLiveLog(jobId: string): string | null {
    const lines = this.liveLogs.get(jobId);
    return lines ? lines.join('\n') : null;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const controller of this.active.values()) {
      controller.abort();
    }
    this.active.clear();
  }

  onStateChange(listener: QueueListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Manual pause. Cooldowns from a rate limit are per-job and clear themselves; this is the only hard stop. */
  pause(): void {
    this.paused = true;
    this.emit();
  }

  resume(): void {
    this.paused = false;
    this.emit();
    void this.tick();
  }

  cancelAll(): number {
    for (const controller of this.active.values()) {
      controller.abort();
    }
    const cancelled = this.jobs.cancelPending();
    this.emit();
    return cancelled;
  }

  getState(): QueueState {
    const counts = this.jobs.getCounts();
    const active = this.jobs.getActive();
    const pending = counts.queued + counts.running + counts.rate_limited;

    // "Stalled" -- as opposed to a manual pause -- means every connector with
    // pending work is currently cooling down, so nothing at all can run right
    // now. That's different from one connector being rate limited while
    // others keep working, which isn't a pause at all from the queue's view.
    const stalled = !this.paused && active.length === 0 && pending > 0 && !this.jobs.hasClaimable();

    return {
      running: !this.stopped && pending > 0,
      paused: this.paused || stalled,
      pausedReason: this.paused ? 'Paused by you.' : stalled ? this.jobs.nextRateLimitReason() : null,
      resumesAt: this.paused ? null : this.jobs.nextEligibleAt(),
      counts,
      active,
      etaSeconds: this.estimateEta(counts.queued + counts.running),
    };
  }

  private emit(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      listener(state);
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.paused) return;

    const concurrency = this.settings.get().jobConcurrency;
    const slots = concurrency - this.active.size;
    if (slots <= 0) return;

    const claimable = this.jobs.claimable(slots);
    if (claimable.length === 0) {
      this.emit();
      return;
    }

    for (const job of claimable) {
      void this.run(job);
    }

    this.emit();
  }

  private async run(job: AiJob): Promise<void> {
    if (this.active.has(job.id)) return;

    const controller = new AbortController();
    this.active.set(job.id, controller);
    this.jobs.markRunning(job.id);

    if (job.itemId) {
      this.items.setAiStatus(job.itemId, 'running');
    }
    this.emit();

    const logLines: string[] = [];
    this.liveLogs.set(job.id, logLines);
    const recordLine = (line: string) => {
      const at = new Date().toISOString();
      logLines.push(`[${at}] ${line}`);
      if (logLines.length > MAX_LOG_LINES) logLines.splice(0, logLines.length - MAX_LOG_LINES);
      this.onCliOutput({ jobId: job.id, at, line });
    };

    try {
      const connector = this.resolveConnector(job);
      const outcome = await this.execute(job, connector.id, controller.signal, recordLine);

      this.jobs.markDone(job.id, {
        tokensIn: outcome.tokensIn,
        tokensOut: outcome.tokensOut,
        webSearches: outcome.webSearches,
        costEstimate: outcome.costEstimate,
        durationMs: outcome.durationMs,
      });

      if (job.itemId) {
        this.items.setAiStatus(job.itemId, 'done');
      }

      this.afterSuccess(job);
    } catch (err) {
      this.handleFailure(job, err);
    } finally {
      this.active.delete(job.id);
      this.liveLogs.delete(job.id);
      if (logLines.length > 0) this.jobs.setCliLog(job.id, logLines.join('\n'));
      this.emit();
    }
  }

  private resolveConnector(job: AiJob) {
    // A job records the connector chosen when it was queued, but that
    // connector may since have been deleted or disabled -- fall back to
    // whatever the task is bound to now rather than failing the job.
    const pinned = job.connectorId ? this.connectors.getById(job.connectorId) : null;
    const connector = pinned?.enabled ? pinned : this.connectors.resolveConnector(job.task);

    if (!connector) {
      throw new AiCapabilityError(
        `No connector is set up for "${job.task}". Add one in Settings and bind it to this task.`
      );
    }
    return connector;
  }

  private async execute(job: AiJob, connectorId: string, signal: AbortSignal, onCliOutput: (line: string) => void) {
    const connector = this.connectors.getById(connectorId)!;

    switch (job.task) {
      case 'identify':
        if (!job.itemId) throw new AiError('Identify job has no item.', false);
        return this.tasks.identify(job.itemId, connector, signal, onCliOutput);

      case 'appraise':
        if (!job.itemId) throw new AiError('Appraise job has no item.', false);
        return await this.tasks.appraise(job.itemId, connector, signal, onCliOutput);

      default:
        throw new AiError(`Task "${job.task}" is not runnable from the queue.`, false);
    }
  }

  /** Chains identify into appraise, and hands the item to duplicate detection. */
  private afterSuccess(job: AiJob): void {
    if (job.task !== 'identify' || !job.itemId) return;

    const settings = this.settings.get();
    if (settings.autoAppraiseAfterIdentify) {
      const connector = this.connectors.resolveConnector('appraise');
      this.jobs.enqueue('appraise', job.itemId, job.collectionId, connector?.id ?? null);
    }

    // Now that the item has a real name, it can be compared against its
    // neighbours -- the safety net that makes wrong auto-grouping cheap.
    this.onIdentifyComplete(job.itemId);
  }

  private handleFailure(job: AiJob, err: unknown): void {
    const error = err instanceof AiError ? err : new AiError(err instanceof Error ? err.message : String(err), true);

    // Out of allowance is not a failure. Only this job's connector waits --
    // jobs bound to a different, healthy connector keep running, since the
    // cooldown is a property of the provider that rejected this one call.
    if (error instanceof AiRateLimitError) {
      this.jobs.markRateLimited(job.id, error.resumeAt, error.message);
      if (job.itemId) this.items.setAiStatus(job.itemId, 'queued');
      return;
    }

    // A bad key or a connector that can't do the job will fail identically for
    // every remaining item, so there is nothing to gain from retrying.
    const fatal = error instanceof AiAuthError || error instanceof AiCapabilityError || !error.retryable;

    if (!fatal && job.attempts < MAX_ATTEMPTS) {
      const delay = BACKOFF_MS[Math.min(job.attempts - 1, BACKOFF_MS.length - 1)];
      this.jobs.retryAfter(job.id, delay, error.message);
      if (job.itemId) this.items.setAiStatus(job.itemId, 'queued');
      return;
    }

    this.jobs.markFailed(job.id, error.detail ? `${error.message} (${error.detail})` : error.message);
    if (job.itemId) this.items.setAiStatus(job.itemId, 'error', error.message);
  }

  /** Rolling ETA from observed durations, so the estimate reflects this machine and this connector. */
  private estimateEta(pending: number): number | null {
    if (pending === 0) return null;

    const concurrency = Math.max(1, this.settings.get().jobConcurrency);
    const perJob = this.averagePendingDuration();
    if (perJob === null) return null;

    return Math.round((pending * perJob) / concurrency / 1000);
  }

  private averagePendingDuration(): number | null {
    const tasks: AiTask[] = ['identify', 'appraise'];
    const samples = tasks
      .map((task) => this.jobs.averageDurationMs(task, null))
      .filter((value): value is number => value !== null);

    if (samples.length === 0) return null;
    return samples.reduce((sum, value) => sum + value, 0) / samples.length;
  }
}
